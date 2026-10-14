import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

import app as worker
from replacement_masks import validate_mask_frames
from adapters.wan_materials import validate_wan_materials


class MaskTests(unittest.TestCase):
    def test_missing_empty_full_and_misaligned_masks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mask = Image.new("L", (64, 64))
            ImageDraw.Draw(mask).rectangle((10, 10, 30, 30), fill=255)
            path = root / "00000001.png"
            mask.save(path)
            self.assertTrue(validate_mask_frames([path], 1, (64, 64))["maskChecked"])
            for count, size in [(2, (64, 64)), (1, (128, 64))]:
                with self.assertRaises(ValueError):
                    validate_mask_frames([path], count, size)
            for color in (0, 255):
                Image.new("L", (64, 64), color).save(path)
                with self.assertRaises(ValueError):
                    validate_mask_frames([path], 1, (64, 64))
            self.assertTrue(validate_mask_frames([path], 1, (64, 64), allow_full=True))


class EngineMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not worker.FFPROBE:
            self.skipTest("FFprobe required")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ("media", "jobs"):
            (self.root / name).mkdir()
        patches = patch.multiple(worker, ROOT=self.root, MEDIA=self.root / "media", JOBS=self.root / "jobs")
        patches.start()
        self.addCleanup(patches.stop)
        await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=1.12", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.12", "-c:v", "libx264", "-c:a", "aac", worker.MEDIA / "source.mp4")
        Image.new("RGB", (160, 96), "red").save(worker.MEDIA / "image.png")
        mask = Image.new("L", (160, 96))
        ImageDraw.Draw(mask).rectangle((30, 20, 80, 60), fill=255)
        mask.save(worker.MEDIA / "mask.png")

    async def run_replacement(self, engine, inputs=None, options=None):
        identifier = str(uuid.uuid4())
        worker.atomic_json(worker.job_path(identifier), {"id": identifier, "status": "running"})
        with patch.object(worker, "run_engine", engine):
            await worker.run_job(identifier, worker.JobRequest(operation="replace", inputs=inputs or {"video": "source.mp4", "image": "image.png", "mask": "mask.png"}, options=options or {"replacement": "product"}))
        return worker.read_job(identifier)

    async def test_static_mask_covers_all_frames_and_padding_is_removed(self):
        async def engine(identifier, name, bindings, work):
            self.assertEqual(name, "vace")
            source = await worker.probe_video(identifier, Path(bindings["video"]))
            mask = await worker.probe_video(identifier, Path(bindings["mask"]))
            self.assertEqual(source["duration"], mask["duration"])
            self.assertEqual((int(bindings["frame_count"]) - 1) % 4, 0)
            return Path(bindings["video"])
        job = await self.run_replacement(engine)
        self.assertEqual(job["status"], "completed", job)
        final = await worker.probe_video("test", worker.MEDIA / job["result"]["file"])
        self.assertEqual(final["duration"], 1.12)
        self.assertTrue(final["audio"])

    async def test_invalid_mask_never_calls_generator(self):
        Image.new("L", (160, 96), 0).save(worker.MEDIA / "mask.png")
        calls = []
        async def engine(*args):
            calls.append(args)
            raise AssertionError("generator must not run")
        job = await self.run_replacement(engine)
        self.assertEqual(job["status"], "failed")
        self.assertEqual(calls, [])

    async def test_selected_time_is_used_and_missing_tracking_frame_blocks_generation(self):
        calls = []
        async def engine(identifier, name, bindings, work):
            calls.append(name)
            self.assertEqual(name, "sam2")
            self.assertEqual(bindings["frame"], "8")
            work.mkdir(parents=True)
            # Deliberately omit the first frame. Renumbering must not hide the gap.
            Image.open(worker.MEDIA / "mask.png").save(work / "00000002.png")
            return [work / "00000002.png"]
        job = await self.run_replacement(engine, {"video": "source.mp4", "image": "image.png"}, {"replacement": "product", "seedTime": .5, "regions": [{"x": .1, "y": .1, "width": .3, "height": .3}]})
        self.assertEqual(job["status"], "failed")
        self.assertEqual(calls, ["sam2"])

    async def test_short_person_output_is_not_published(self):
        async def engine(identifier, name, bindings, work):
            output = work / "short.mp4"
            await worker.ffmpeg(identifier, "-i", worker.MEDIA / "source.mp4", "-t", .4, "-an", output)
            return output
        job = await self.run_replacement(engine, {"video": "source.mp4", "image": "image.png"}, {"replacement": "person"})
        self.assertEqual(job["status"], "failed")
        self.assertIn("时长", job["error"])

    async def test_wan_preprocessing_rejects_empty_opening_mask(self):
        processed = self.root / "wan"
        processed.mkdir()
        for name in ("src_pose", "src_face", "src_bg", "src_mask"):
            await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "color=black:s=160x96:r=25:d=1", "-c:v", "libx264", processed / f"{name}.mp4")
        with self.assertRaisesRegex(ValueError, "第 1 帧"):
            validate_wan_materials(processed)

    async def test_wan_preprocessing_rejects_truncated_materials(self):
        processed = self.root / "truncated-wan"
        processed.mkdir()
        for name in ("src_pose", "src_face", "src_bg", "src_mask"):
            await worker.ffmpeg("fixture", "-loop", 1, "-i", worker.MEDIA / "mask.png", "-r", 25, "-t", .4, "-c:v", "libx264", "-pix_fmt", "yuv420p", processed / f"{name}.mp4")
        with self.assertRaisesRegex(ValueError, "覆盖原视频时长"):
            validate_wan_materials(processed, worker.MEDIA / "source.mp4")


if __name__ == "__main__":
    unittest.main()
