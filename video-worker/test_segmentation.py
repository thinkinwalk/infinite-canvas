import asyncio
import hashlib
import math
import random
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import app as worker
from segmentation import plan_segments, segment_limits, silence_midpoints


class SegmentPlanningTests(unittest.TestCase):
    def assert_timeline(self, parts, duration, minimum, maximum):
        self.assertEqual(parts[0]["start"], 0)
        self.assertEqual(parts[-1]["end"], math.floor(duration * 1000) / 1000)
        for index, part in enumerate(parts):
            length = round(part["end"] * 1000) - round(part["start"] * 1000)
            self.assertGreaterEqual(length, math.ceil(minimum * 1000))
            self.assertLessEqual(length, math.floor(maximum * 1000))
            if index:
                self.assertEqual(parts[index - 1]["end"], part["start"])

    def test_scenes_and_pauses_are_preferred_without_leaving_a_short_tail(self):
        parts = plan_segments(31, 2, 15, 15, cuts=[10, 20])
        self.assertEqual([part["end"] for part in parts], [10, 20, 31])
        self.assertEqual([part["boundary"] for part in parts], ["scene", "scene", "end"])
        parts = plan_segments(20, 2, 15, 10, pauses=[9.8])
        self.assertEqual(parts[0]["end"], 9.8)
        self.assertEqual(parts[0]["boundary"], "silence")
        self.assert_timeline(plan_segments(30.2, 2, 15, 15), 30.2, 2, 15)

    def test_short_scenes_are_packed_and_long_single_shots_are_split(self):
        parts = plan_segments(60, 2, 15, 15, cuts=[0.2, 0.5, 0.8, 15, 30, 45])
        self.assertEqual(len(parts), 4)
        self.assert_timeline(parts, 60, 2, 15)
        self.assert_timeline(plan_segments(92.4, 2, 15, 15), 92.4, 2, 15)

    def test_randomized_feasible_timelines_never_gap_overlap_or_exceed_limits(self):
        rng = random.Random(17)
        for _ in range(500):
            low = rng.randint(1000, 5000)
            high = rng.randint(low, 30000)
            length = rng.randint(low, 180000)
            feasible = math.ceil(length / high) <= length // low
            if not feasible:
                continue
            duration, minimum, maximum = length / 1000, low / 1000, high / 1000
            target = rng.randint(low, high) / 1000
            cuts = [rng.uniform(0, duration) for _ in range(20)]
            self.assert_timeline(plan_segments(duration, minimum, maximum, target, cuts), duration, minimum, maximum)

    def test_invalid_or_impossible_specs_fail_instead_of_dropping_tail_or_padding(self):
        for args in [(1, 2, 15, 15), (10.5, 5, 5, 5), (0, 1, 30, 15), (float("nan"), 1, 30, 15)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                plan_segments(*args)
        for minimum, maximum, target in [(0, 30, 15), (1, 31, 15), (3, 2, 2), (1, 30, float("inf"))]:
            with self.assertRaises(ValueError):
                segment_limits(dict(minSeconds=minimum, maxSeconds=maximum, targetSeconds=target))

    def test_silence_intervals_use_midpoints_and_ignore_unmatched_ends(self):
        self.assertEqual(silence_midpoints("silence_end: 1\nsilence_start: 2.0\nsilence_end: 2.6\nsilence_start: 9"), [2.3])


class SegmentWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.media, self.jobs = self.root / "media", self.root / "jobs"
        self.media.mkdir()
        self.jobs.mkdir()
        replacement = patch.multiple(worker, MEDIA=self.media, JOBS=self.jobs, TASKS={}, SEGMENT_QUEUE=asyncio.Semaphore(1))
        replacement.start()
        self.addCleanup(replacement.stop)

    def job(self, request):
        identifier = str(uuid.uuid4())
        worker.atomic_json(self.jobs / f"{identifier}.json", {"id": identifier, "status": "running", "request": request.model_dump()})
        return identifier

    async def fixture(self, audio=True):
        source = self.media / "source.mp4"
        await worker.ffmpeg("fixture", "-v", "error", "-f", "lavfi", "-i",
                            "color=red:size=160x90:rate=25:duration=3",
                            "-f", "lavfi", "-i", "color=blue:size=160x90:rate=25:duration=3",
                            *(["-f", "lavfi", "-i", "sine=frequency=440:duration=6"] if audio else []),
                            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
                            *(["-map", "2:a"] if audio else []),
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source)
        reference = str(uuid.uuid4())
        worker.atomic_json(source.with_suffix(".mp4.json"), {"temporaryReference": reference})
        return source, reference

    async def test_real_detector_plan_and_reused_input_trim_keep_source_and_retention(self):
        source, reference = await self.fixture()
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        request = worker.JobRequest(operation="segment-plan", inputs={"video": source.name}, options={"minSeconds": 1, "maxSeconds": 4, "targetSeconds": 3})
        worker.validate_options(request)
        identifier = self.job(request)
        await worker.run_job(identifier, request)
        job = worker.read_job(identifier)
        self.assertEqual(job["status"], "completed", job.get("error"))
        plan = job["result"]["metadata"]
        self.assertGreaterEqual(plan["sceneCount"], 1)
        self.assertAlmostEqual(plan["parts"][0]["end"], 3, places=1)
        for part in plan["parts"]:
            request = worker.JobRequest(operation="trim", inputs={"video": source.name}, options={**part, "segmentQueue": True})
            identifier = self.job(request)
            await worker.run_job(identifier, request)
            result = worker.read_job(identifier)
            self.assertEqual(result["status"], "completed", result.get("error"))
            output = self.media / result["result"]["file"]
            info = worker.metadata(output)
            self.assertGreaterEqual(info["duration"], 1)
            self.assertLessEqual(info["duration"], 4)
            self.assertEqual(worker.json.loads(output.with_suffix(".mp4.json").read_text())["temporaryReference"], reference)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)

    async def test_no_audio_still_generates_a_complete_plan(self):
        source, _ = await self.fixture(audio=False)
        request = worker.JobRequest(operation="segment-plan", inputs={"video": source.name}, options={"minSeconds": 1, "maxSeconds": 4, "targetSeconds": 3})
        identifier = self.job(request)
        await worker.run_job(identifier, request)
        result = worker.read_job(identifier)
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["result"]["metadata"]["pauseCount"], 0)

    async def test_fractional_frame_rate_at_model_maximum_does_not_overrun(self):
        source = self.media / "fractional.mp4"
        await worker.ffmpeg("fixture", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc2=size=160x90:rate=30000/1001:duration=16",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=16",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source)
        request = worker.JobRequest(operation="trim", inputs={"video": source.name},
                                    options={"start": 0, "end": 15, "segmentQueue": True})
        identifier = self.job(request)
        await worker.run_job(identifier, request)
        result = worker.read_job(identifier)
        self.assertEqual(result["status"], "completed", result.get("error"))
        info = worker.metadata(self.media / result["result"]["file"])
        self.assertLessEqual(info["duration"], 15)
        self.assertGreaterEqual(info["duration"], 14.999)
        self.assertIn("aac", info["audio_codec"])

    async def test_queued_cancel_never_decodes_and_releases_no_extra_slot(self):
        source = self.media / "source.mp4"
        source.write_bytes(b"fixture")
        request = worker.JobRequest(operation="segment-plan", inputs={"video": source.name}, options={"minSeconds": 1, "maxSeconds": 4, "targetSeconds": 3})
        first_id, second_id = self.job(request), self.job(request)
        entered, release = asyncio.Event(), asyncio.Event()
        count = 0

        async def analyze(*args, **kwargs):
            nonlocal count
            count += 1
            entered.set()
            await release.wait()
            return {"metadata": {}}

        with patch.object(worker, "analyze_segments", analyze):
            first = asyncio.create_task(worker.run_job(first_id, request))
            await entered.wait()
            second = asyncio.create_task(worker.run_job(second_id, request))
            await asyncio.sleep(0)
            self.assertEqual(worker.read_job(second_id)["step"], "等待分段处理")
            second.cancel()
            await second
            self.assertEqual(worker.read_job(second_id)["status"], "cancelled")
            self.assertEqual(count, 1)
            self.assertTrue(worker.SEGMENT_QUEUE.locked())
            release.set()
            await first
            self.assertFalse(worker.SEGMENT_QUEUE.locked())

    async def test_failed_analysis_releases_queue_and_reports_failure(self):
        source = self.media / "source.mp4"
        source.write_bytes(b"fixture")
        request = worker.JobRequest(operation="segment-plan", inputs={"video": source.name}, options={"minSeconds": 1, "maxSeconds": 4, "targetSeconds": 3})
        identifier = self.job(request)
        with patch.object(worker, "analyze_segments", side_effect=ValueError("无法解码")):
            await worker.run_job(identifier, request)
        self.assertEqual(worker.read_job(identifier)["status"], "failed")
        self.assertFalse(worker.SEGMENT_QUEUE.locked())


if __name__ == "__main__":
    unittest.main()
