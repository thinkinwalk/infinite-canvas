"""Real FFmpeg regression tests. Supply FFPROBE_PATH or install ffprobe."""
import asyncio
import math
import hashlib
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path

import imageio_ffmpeg

from replacement import process, probe


class ReplacementMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ffprobe = os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe")
        if not self.ffprobe:
            self.skipTest("FFprobe is required for real media tests")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.step = 0

    async def command(self, identifier, args):
        child = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await child.communicate()
        if child.returncode:
            raise RuntimeError(err.decode(errors="replace"))
        return out.decode(errors="replace"), err.decode(errors="replace")

    async def ffmpeg(self, identifier, *args):
        return await self.command(identifier, [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-nostdin", *args])

    async def probe_video(self, identifier, path):
        return await probe(identifier, path, self.command, self.ffprobe)

    async def operation(self, name, inputs, options):
        self.step += 1
        work = self.root / str(self.step)
        work.mkdir()
        return await process(name, "test", inputs, options, work, ffmpeg=self.ffmpeg, probe_video=self.probe_video, publish=lambda path: path)

    async def test_fractional_fps_does_not_add_a_billable_second(self):
        source = self.root / "source.mp4"
        await self.ffmpeg("test", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=30000/1001:d=12.125", "-an", "-c:v", "libx264", source)
        plan = await self.operation("replacement-plan", {"video": source}, {"seconds": 10})
        parts = plan["metadata"]["parts"]
        outputs = []
        for part in parts:
            clip = await self.operation("replacement-extract", {"video": source}, part)
            info = await self.probe_video("test", clip["file"])
            self.assertEqual(math.ceil(info["duration"]), 10)
            outputs.append(clip["file"])
        final = await self.operation("replacement-assemble", {"video": source, "parts": outputs}, {"parts": parts})
        info = await self.probe_video("test", final["file"])
        self.assertEqual(info["duration"], plan["metadata"]["duration"])
        self.assertFalse(info["audio"])

    async def test_fit_nonstandard_portrait_preserves_picture_audio_and_original(self):
        source = self.root / "portrait.mp4"
        await self.ffmpeg("test", "-f", "lavfi", "-i", "color=c=red:s=544x960:r=25:d=1",
                          "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                          "-c:v", "libx264", "-c:a", "aac", source)
        original_hash = hashlib.sha256(source.read_bytes()).digest()
        for ratio, size in (("9:16", (558, 992)), ("16:9", (1728, 972)), ("1:1", (960, 960)),
                            ("21:9", (2268, 972)), ("4:3", (1280, 960)), ("3:4", (720, 960))):
            fitted = await self.operation("replacement-fit", {"video": source}, {"aspectRatio": ratio})
            info = await self.probe_video("test", fitted["file"])
            self.assertEqual(info["size"], size)
            self.assertEqual(info["duration"], 1)
            self.assertEqual(info["fps"], 25)
            self.assertTrue(info["audio"])
            audio, _ = await self.command("test", [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", fitted["file"], "-map", "0:a", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])
            original_audio, _ = await self.command("test", [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", source, "-map", "0:a", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])
            self.assertEqual(audio, original_audio)
            # The original red picture remains at its original pixel dimensions.
            _, crop = await self.ffmpeg("test", "-i", fitted["file"], "-vf", "crop=540:956:(iw-540)/2:(ih-956)/2,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-")
            self.assertAlmostEqual(float(re.search(r"lavfi.signalstats.YAVG=([\d.]+)", crop).group(1)), 81, delta=0.1)
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), original_hash)

    async def test_fit_canvas_is_kept_through_extract_export_and_assembly(self):
        source = self.root / "portrait.mp4"
        await self.ffmpeg("test", "-f", "lavfi", "-i", "color=c=red:s=544x960:r=25:d=1",
                          "-an", "-c:v", "libx264", source)
        fitted = (await self.operation("replacement-fit", {"video": source}, {"aspectRatio": "9:16"}))["file"]
        part = (await self.operation("replacement-plan", {"video": fitted}, {"seconds": 4}))["metadata"]["parts"][0]
        clip = (await self.operation("replacement-extract", {"video": fitted}, part))["file"]
        segment = await self.operation("replacement-segment", {"video": clip, "source": fitted, "input": clip},
                                       {"start": 0, "end": 1, "trimStart": 0})
        final = await self.operation("replacement-assemble", {"video": fitted, "parts": [clip]}, {"parts": [part]})
        for path, duration in ((clip, 4), (segment["file"], 1), (final["file"], 1)):
            info = await self.probe_video("test", path)
            self.assertEqual(info["size"], (558, 992))
            self.assertLessEqual(abs(info["duration"] - duration), 1 / info["fps"])
            self.assertFalse(info["audio"])

    async def test_invalid_fit_ratio_never_calls_ffmpeg(self):
        for ratio in ("17:30", "arbitrary", None):
            with self.assertRaisesRegex(ValueError, "生成画幅"):
                await self.operation("replacement-fit", {"video": self.root / "missing.mp4"}, {"aspectRatio": ratio})

    async def test_assembly_fits_standard_generated_canvas_without_stretching(self):
        source, generated = self.root / "source.mp4", self.root / "generated.mp4"
        for path, size in ((source, "544x960"), (generated, "720x1280")):
            await self.ffmpeg("test", "-f", "lavfi", "-i", f"color=c=red:s={size}:r=30:d=1", "-an", "-c:v", "libx264", path)
        await self.operation("replacement-validate", {"video": generated, "source": source}, {})
        part = {"start": 0, "end": 1, "trimStart": 0, "seconds": 1}
        final = await self.operation("replacement-assemble", {"video": source, "parts": [generated]}, {"parts": [part]})
        info = await self.probe_video("test", final["file"])
        self.assertEqual(info["size"], (544, 960))
        self.assertEqual(info["duration"], 1)
        raw, _ = await self.command("test", [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", final["file"], "-vf", "crop=2:960:0:0,signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"])
        self.assertIn("lavfi.signalstats.YAVG=16", raw)

    async def test_short_shot_is_padded_then_restored_to_original_length(self):
        source = self.root / "short.mp4"
        await self.ffmpeg("test", "-f", "lavfi", "-i", "color=c=red:s=160x96:r=25:d=0.12", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.12", "-c:v", "libx264", "-c:a", "aac", source)
        plan = await self.operation("replacement-plan", {"video": source}, {"seconds": 4})
        part = plan["metadata"]["parts"][0]
        clip = await self.operation("replacement-extract", {"video": source}, part)
        self.assertEqual((await self.probe_video("test", clip["file"]))["duration"], 4)
        final = await self.operation("replacement-assemble", {"video": source, "parts": [clip["file"]]}, {"parts": [part]})
        self.assertEqual((await self.probe_video("test", final["file"]))["duration"], 0.12)


if __name__ == "__main__":
    unittest.main()
