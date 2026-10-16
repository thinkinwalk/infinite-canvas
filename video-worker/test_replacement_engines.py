import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

import app as worker
from replacement_masks import composite_masked_frames, grow_mask_to_subject, validate_mask_frames
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

    def test_masked_composite_preserves_source_outside_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original.png"
            generated = root / "generated.png"
            mask = root / "mask.png"
            Image.new("RGB", (4, 2), "blue").save(original)
            # The model only redraws inside the mask; the rest matches the source.
            model = Image.new("RGB", (4, 2), "blue")
            ImageDraw.Draw(model).rectangle((1, 0, 2, 1), fill="red")
            model.save(generated)
            target = Image.new("L", (4, 2))
            ImageDraw.Draw(target).rectangle((1, 0, 2, 1), fill=255)
            target.save(mask)
            frames = composite_masked_frames([original], [generated], [mask], root / "out", (4, 2), feather=0)
            with Image.open(frames[0]) as result:
                self.assertEqual(result.getpixel((0, 0)), (0, 0, 255))
                self.assertEqual(result.getpixel((1, 0)), (255, 0, 0))

    def test_grow_follows_new_subject_but_not_remote_background_edits(self):
        tracked = np.zeros((100, 100), dtype=bool)
        tracked[30:70, 30:60] = True
        original = np.full((100, 100, 3), 20, dtype=np.int16)
        generated = original.copy()
        # The new subject is wider than the tracked mask: this limb must be kept.
        generated[30:70, 60:72] = 200
        # A far-away background edit must not be pulled into the person.
        generated[0:6, 90:96] = 200
        grown = grow_mask_to_subject(tracked, original, generated)
        self.assertTrue(grown[50, 66])
        self.assertFalse(grown[2, 92])
        self.assertTrue(tracked[50, 40] and grown[50, 40])

    def test_grow_stops_when_the_model_repaints_the_frame(self):
        tracked = np.zeros((100, 100), dtype=bool)
        tracked[30:70, 30:60] = True
        original = np.full((100, 100, 3), 20, dtype=np.int16)
        generated = np.full((100, 100, 3), 200, dtype=np.int16)
        with self.assertRaises(ValueError):
            grow_mask_to_subject(tracked, original, generated)

    def test_caption_glyphs_are_restored_from_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            size = (64, 64)
            original = Image.new("RGB", size, "black")
            # Thin bright caption strokes sitting on top of the subject.
            painter = ImageDraw.Draw(original)
            for x in range(12, 31, 4):
                painter.rectangle((x, 10, x + 1, 20), fill=(255, 240, 0))
            generated = Image.new("RGB", size, "black")
            # The model redraws a solid subject only inside the tracked mask.
            ImageDraw.Draw(generated).rectangle((5, 5, 40, 40), fill=(0, 200, 0))
            mask = Image.new("L", size)
            ImageDraw.Draw(mask).rectangle((5, 5, 40, 40), fill=255)
            original.save(root / "o.png")
            generated.save(root / "g.png")
            mask.save(root / "m.png")
            frames = composite_masked_frames([root / "o.png"], [root / "g.png"], [root / "m.png"], root / "out", size, feather=0, protect=[[(8, 8, 34, 24)]])
            with Image.open(frames[0]) as result:
                stroke = result.getpixel((12, 15))
                self.assertGreater(stroke[0], 200)
                self.assertGreater(stroke[1], 180)
                # Away from the caption the generated subject still wins.
                self.assertGreater(result.getpixel((35, 35))[1], 150)


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

    async def test_masked_person_replacement_composites_generated_subject_over_original(self):
        await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "color=c=red:s=160x96:r=25:d=1.12", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.12", "-c:v", "libx264", "-c:a", "aac", worker.MEDIA / "source.mp4")

        async def engine(identifier, name, bindings, work):
            self.assertEqual(name, "vace")
            output = work / "model-output.mp4"
            # Redraw only the masked subject area; the rest matches the source so
            # the mask-growth guard sees a localized change, as in production.
            await worker.ffmpeg(identifier, "-f", "lavfi", "-i", "color=c=red:s=160x96:r=16", "-frames:v", bindings["frame_count"],
                                "-vf", "drawbox=x=30:y=20:w=50:h=40:color=green:t=fill",
                                "-c:v", "libx264", "-pix_fmt", "yuv420p", output)
            return output

        job = await self.run_replacement(engine, options={"replacement": "person", "maskedPerson": True})
        self.assertEqual(job["status"], "completed", job)
        self.assertTrue(job["result"]["metadata"]["maskedComposite"])
        frame = self.root / "result.png"
        await worker.ffmpeg("fixture", "-i", worker.MEDIA / job["result"]["file"], "-frames:v", "1", frame)
        with Image.open(frame) as image:
            self.assertGreater(image.getpixel((10, 10))[0], 200)
            self.assertGreater(image.getpixel((55, 40))[1], 100)

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

    async def test_cloud_masked_composite_accepts_wan_animate_size_and_one_frame_short(self):
        # Production shape: 480x848@30 source, 464x832 Wan-Animate output one frame short.
        await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "color=c=red:s=480x848:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", worker.MEDIA / "wide.mp4")
        # The model output matches the source except inside the subject area, which
        # is the realistic case the mask-growth guard is designed to accept.
        await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "color=c=red:s=464x832:r=30", "-frames:v", 29, "-vf", "drawbox=x=145:y=294:w=180:h=390:color=green:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", worker.MEDIA / "animate.mp4")
        mask = Image.new("L", (480, 848))
        ImageDraw.Draw(mask).rectangle((150, 300, 330, 700), fill=255)
        mask.save(worker.MEDIA / "person.png")
        identifier = str(uuid.uuid4())
        worker.atomic_json(worker.job_path(identifier), {"id": identifier, "status": "running"})
        await worker.run_job(identifier, worker.JobRequest(operation="replacement-masked-composite", inputs={"source": "wide.mp4", "video": "animate.mp4", "mask": "person.png"}, options={}))
        job = worker.read_job(identifier)
        self.assertEqual(job["status"], "completed", job)
        output = worker.MEDIA / job["result"]["file"]
        final = await worker.probe_video("test", output)
        self.assertEqual(final["size"], (480, 848))
        self.assertAlmostEqual(final["duration"], 1, delta=1 / 30)
        self.assertTrue(final["audio"])
        frame = self.root / "last.png"
        await worker.ffmpeg("fixture", "-ss", 0.95, "-i", output, "-frames:v", "1", frame)
        with Image.open(frame) as image:
            self.assertGreater(image.getpixel((20, 20))[0], 200)
            self.assertGreater(image.getpixel((240, 500))[1], 100)

    async def test_cloud_masked_composite_rejects_swapped_orientation(self):
        await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "color=c=red:s=480x848:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", worker.MEDIA / "wide.mp4")
        await worker.ffmpeg("fixture", "-f", "lavfi", "-i", "color=c=green:s=832x464:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", worker.MEDIA / "animate.mp4")
        identifier = str(uuid.uuid4())
        worker.atomic_json(worker.job_path(identifier), {"id": identifier, "status": "running"})
        await worker.run_job(identifier, worker.JobRequest(operation="replacement-masked-composite", inputs={"source": "wide.mp4", "video": "animate.mp4", "mask": "mask.png"}, options={}))
        job = worker.read_job(identifier)
        self.assertEqual(job["status"], "failed")
        self.assertIn("画幅比例", job["error"])


if __name__ == "__main__":
    unittest.main()
