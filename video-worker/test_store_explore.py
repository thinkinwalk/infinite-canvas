import asyncio
import hashlib
import math
import os
import shutil
import tempfile
import unittest
import struct
import wave
from pathlib import Path
import imageio_ffmpeg
from replacement import probe
from store_explore import compose, validate_captions, validate_options
from app import write_subtitles


class StoreValidationTests(unittest.TestCase):
    def test_invalid_options(self):
        for options in ({"audioMode": "other"}, {"audioMode": "narration"}, {"musicVolume": float("nan")}, {"musicVolume": 2}):
            with self.assertRaises(ValueError):
                validate_options({"video": "video"}, options)

    def test_bad_caption_timeline(self):
        for rows in ([{"start": 0, "end": 6, "text": "a"}], [{"start": 0, "end": 2, "text": "a"}, {"start": 1, "end": 3, "text": "b"}], [{"start": 0, "end": 1, "text": ""}]):
            with self.assertRaises(ValueError):
                validate_captions(rows, 5)


class StoreMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ffprobe = os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe")
        if not self.ffprobe:
            self.skipTest("FFprobe required")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp4"
        self.voice = self.root / "voice.wav"
        self.music = self.root / "music.wav"
        self.count = 0
        await self.ffmpeg("test", "-f", "lavfi", "-i", "color=c=red:s=160x96:r=25:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", self.source)
        await self.ffmpeg("test", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", self.voice)
        await self.ffmpeg("test", "-f", "lavfi", "-i", "sine=frequency=220:duration=0.5", self.music)
        self.hash = hashlib.sha256(self.source.read_bytes()).hexdigest()

    async def command(self, identifier, args):
        proc = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await proc.communicate()
        if proc.returncode:
            raise RuntimeError(err.decode(errors="replace"))
        return out.decode(errors="replace"), err.decode(errors="replace")

    async def ffmpeg(self, identifier, *args):
        return await self.command(identifier, [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-nostdin", *args])

    async def probe_video(self, identifier, path):
        return await probe(identifier, path, self.command, self.ffprobe)

    async def finish(self, inputs, options):
        self.count += 1
        work = self.root / str(self.count)
        work.mkdir()
        return await compose("test", inputs, options, work, command=self.command, ffprobe=self.ffprobe, ffmpeg=self.ffmpeg, probe_video=self.probe_video, write_subtitles=write_subtitles, publish=lambda p: p)

    async def test_replace_narration_not_double_voice_and_keep_full_video(self):
        result = await self.finish({"video": self.source, "narration": self.voice}, {"audioMode": "narration"})
        info = await self.probe_video("test", result["file"])
        self.assertEqual(info["duration"], 2)
        self.assertTrue(info["audio"])
        decoded = self.root / "decoded.wav"
        await self.ffmpeg("test", "-v", "error", "-i", result["file"], "-map", "0:a", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", decoded)
        with wave.open(str(decoded)) as audio:
            samples = struct.unpack("<" + "h" * audio.getnframes(), audio.readframes(audio.getnframes()))
        def energy(frequency):
            part = samples[800:6400]
            return abs(sum(value * complex(math.cos(2 * math.pi * frequency * i / 8000), math.sin(2 * math.pi * frequency * i / 8000)) for i, value in enumerate(part)))
        self.assertGreater(energy(880), 10 * energy(440))
        self.assertLess(max(abs(v) for v in samples[12000:15000]), 10)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.hash)

    async def test_music_loops_without_shortening_video_and_mute_removes_source(self):
        muted = await self.finish({"video": self.source}, {"audioMode": "mute"})
        self.assertFalse((await self.probe_video("test", muted["file"]))["audio"])
        mixed = await self.finish({"video": self.source, "narration": self.voice, "music": self.music}, {"audioMode": "narration", "musicVolume": 0.2})
        info = await self.probe_video("test", mixed["file"])
        self.assertEqual(info["duration"], 2)
        self.assertTrue(info["audio"])

    async def test_long_narration_fails_without_cutting_or_changing_original(self):
        long = self.root / "long.wav"
        await self.ffmpeg("test", "-f", "lavfi", "-i", "sine=duration=3", long)
        with self.assertRaisesRegex(ValueError, "不会截断"):
            await self.finish({"video": self.source, "narration": long}, {"audioMode": "narration"})
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.hash)

    async def test_captions_burn_with_real_ass_renderer(self):
        result = await self.finish({"video": self.source}, {"audioMode": "source", "subtitles": [{"start": 0, "end": 1, "text": "Store 20"}], "subtitleSize": 16, "subtitleBottom": 0.08})
        self.assertEqual((await self.probe_video("test", result["file"]))["duration"], 2)
        args = ["-ss", "0.5", "-frames:v", "1", "-map", "0:v", "-f", "hash", "-hash", "sha256", "-"]
        before, _ = await self.ffmpeg("test", "-v", "error", "-i", self.source, *args)
        after, _ = await self.ffmpeg("test", "-v", "error", "-i", result["file"], *args)
        self.assertNotEqual(before, after)


if __name__ == "__main__":
    unittest.main()
