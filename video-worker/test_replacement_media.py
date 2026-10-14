"""Real FFmpeg regression tests. Supply FFPROBE_PATH or install ffprobe."""
import asyncio
import math
import os
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
