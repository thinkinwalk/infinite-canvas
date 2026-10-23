import asyncio
import hashlib
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import app as worker


class ExtractionTrimTests(unittest.IsolatedAsyncioTestCase):
    def test_decimal_boundaries_preserve_the_existing_one_to_thirty_second_range(self):
        for start, end in [(0, 1), (0.14, 1.14), (0.14, 30.14)]:
            worker.validate_options(worker.JobRequest(operation="trim", inputs={"video": "test.mp4"}, options={"start": start, "end": end}))
        for start, end in [(-1, 1), (0, 0.999), (0, 30.001), (2, 1), (0, float("inf")), (float("nan"), 10)]:
            with self.subTest(start=start, end=end), self.assertRaises(worker.HTTPException):
                worker.validate_options(worker.JobRequest(operation="trim", inputs={"video": "test.mp4"}, options={"start": start, "end": end}))

    async def test_decimal_selection_produces_a_playable_clip_with_audio_and_keeps_original(self):
        await self.check_decimal_clip(audio=True)

    async def test_decimal_selection_without_audio_still_produces_a_full_one_second_clip(self):
        await self.check_decimal_clip(audio=False)

    async def check_decimal_clip(self, audio):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            media, jobs = root / "media", root / "jobs"
            media.mkdir()
            jobs.mkdir()
            with patch.multiple(worker, MEDIA=media, JOBS=jobs, TASKS={}):
                source = media / "source.mp4"
                process = await asyncio.create_subprocess_exec(
                    worker.FFMPEG, "-y", "-nostdin", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=3",
                    *(["-f", "lavfi", "-i", "sine=frequency=440:duration=3"] if audio else []),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                _, error = await process.communicate()
                self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
                before = hashlib.sha256(source.read_bytes()).digest()
                reference = str(uuid.uuid4())
                worker.atomic_json(source.with_suffix(".mp4.json"), {"temporaryReference": reference})
                request = worker.JobRequest(operation="trim", inputs={"video": source.name}, options={"start": 0.14, "end": 1.14})
                worker.validate_options(request)
                identifier = str(uuid.uuid4())
                worker.atomic_json(jobs / f"{identifier}.json", {"id": identifier, "status": "running", "request": request.model_dump()})
                await worker.run_job(identifier, request)
                job = worker.read_job(identifier)
                self.assertEqual(job["status"], "completed", job.get("error"))
                clipped = media / job["result"]["file"]
                meta = await asyncio.to_thread(worker.metadata, clipped)
                self.assertGreaterEqual(meta["duration"], 1)
                self.assertLess(meta["duration"], 1.1)
                self.assertIn("h264", meta["codec"])
                if audio:
                    self.assertIn("aac", meta["audio_codec"])
                self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)
                self.assertEqual(worker.json.loads(clipped.with_suffix(".mp4.json").read_text())["temporaryReference"], reference)
                self.assertFalse((jobs / identifier).exists())


if __name__ == "__main__":
    unittest.main()
