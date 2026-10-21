import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

import app as worker
import remote_subtitles
from replacement_subtitles import audio_captions, locate_caption_masks


def detection(text, box):
    left, top, right, bottom = box
    return {"rec_texts": [text], "rec_polys": [[[left, top], [right, top], [right, bottom], [left, bottom]]]}


class CaptionMasksTests(unittest.TestCase):
    def test_typing_caption_uses_geometry_even_when_asr_is_wrong_and_keeps_sign(self):
        frames = [[detection(text, (180, 930, 530, 1030)), detection("招牌商店", (120, 400, 560, 480))]
                  for text in ["配色", "配色请", "配色请收藏", "配色请收藏"]]
        masks = locate_caption_masks(frames, (720, 1280), 2, [{"start": 0, "end": 2, "text": "识别错误的原音"}])
        self.assertTrue(all(masks))
        self.assertTrue(all(box[1] > 900 for frame in masks for box in frame))

    def test_static_unrelated_lower_sign_is_not_caption(self):
        frames = [[detection("欢迎光临", (180, 930, 530, 1030))] for _ in range(4)]
        with self.assertRaisesRegex(ValueError, "无法可靠区分"):
            locate_caption_masks(frames, (720, 1280), 2, [{"start": 0, "end": 2, "text": "今天介绍一下"}])

    def test_ambiguous_opening_title_does_not_silently_survive_cleanup(self):
        frames = [[detection("开头花字", (150, 600, 550, 730))],
                  [detection("配色", (180, 930, 530, 1030))],
                  [detection("配色请收藏", (180, 930, 530, 1030))]]
        with self.assertRaisesRegex(ValueError, "开头"):
            locate_caption_masks(frames, (720, 1280), 2, [{"start": .72, "end": 1.5, "text": "配色请收藏"}])

    def test_audio_text_is_simplified_and_bad_timestamps_fail(self):
        self.assertEqual(audio_captions([{"start": 0, "end": 1, "text": "請收藏！"}], 2)[0]["text"], "请收藏！")
        for segments in ([], [{"start": 0, "end": 3, "text": "超长"}],
                         [{"start": 0, "end": 1, "text": "前句"}, {"start": .5, "end": 2, "text": "重叠"}]):
            with self.assertRaises(ValueError):
                audio_captions(segments, 2)


class SubtitlePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ("media", "jobs"):
            (self.root / name).mkdir()
        for name in ("source.mp4", "generated.mp4", "clean.mp4"):
            (self.root / "media" / name).write_bytes(b"test")
        self.patches = patch.multiple(worker, ROOT=self.root, MEDIA=self.root / "media", JOBS=self.root / "jobs")
        self.patches.start()
        self.addCleanup(self.patches.stop)
        self.info = {"audio": True, "duration": 3, "fps": 25, "size": (720, 1280)}

    async def run_job(self, operation, options):
        identifier = str(uuid.uuid4())
        worker.atomic_json(worker.job_path(identifier), {"id": identifier, "status": "running"})
        inputs = {"video": "source.mp4"} if operation in ("replacement-prepare", "replacement-transcribe") else {"video": "generated.mp4", "source": "source.mp4"}
        await worker.run_job(identifier, worker.JobRequest(operation=operation, inputs=inputs, options=options))
        return worker.read_job(identifier)

    async def test_prepare_calls_new_cleaner_without_returning_ocr_captions(self):
        cleaner = AsyncMock(return_value=worker.MEDIA / "clean.mp4")
        with patch.dict("os.environ", {"GPU_WORKER_URL": ""}), patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "transcribe", AsyncMock(return_value=[{"start": 0, "end": 2, "text": "原音轨"}])), patch.object(worker, "clean_spoken_subtitles", cleaner), patch.object(worker, "repair_frames", AsyncMock(side_effect=AssertionError("legacy path"))):
            state = await self.run_job("replacement-prepare", {"subtitleMethod": "audio-after-generation"})
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["segments"], [])
        cleaner.assert_awaited_once()

    async def test_residual_detection_cannot_succeed_with_missing_frames_or_unreadable_text(self):
        for missing in (False, True):
            work = self.root / str(missing)
            work.mkdir()
            async def ffmpeg(identifier, *args):
                for index in (1, 2):
                    Image.new("RGB", (720, 1280)).save(args[-1].parent / f"{index:08d}.png")
            async def command(identifier, args):
                output = Path(args[-1])
                after = "repaired" in output.name
                # Text recognition may fail even though the text detector sees a box.
                items = [detection("" if after else "请收藏", (180, 930, 530, 1030))]
                count = 1 if after and missing else 2
                output.write_text("\n".join(json.dumps({"file": f"{i:08d}.png", "items": items}) for i in range(1, count + 1)))
            async def engine(identifier, name, bindings, directory):
                return sorted(p for p in Path(bindings["frames"]).glob("*.png") if not p.stem.endswith("_mask"))
            with patch.object(worker, "metadata", return_value={**self.info, "fps": 2}), patch.object(worker, "ffmpeg", ffmpeg), patch.object(worker, "command", command), patch.object(worker, "run_engine", engine), patch.object(worker, "update_job"):
                with self.assertRaisesRegex(ValueError, "帧不完整" if missing else "仍检测到文字"):
                    await worker.clean_spoken_subtitles("test", worker.MEDIA / "source.mp4", work, [{"start": 0, "end": 1, "text": "请收藏"}])

    async def test_finish_recognizes_source_audio_and_ignores_old_ocr_text(self):
        captions = [{"start": 0, "end": 2, "text": "来自原音轨"}]
        transcribe = AsyncMock(return_value=captions)
        async def ffmpeg(identifier, *args):
            self.assertEqual(args[:4], ("-i", worker.MEDIA / "generated.mp4", "-i", worker.MEDIA / "source.mp4"))
            args[-1].write_bytes(b"final")
        with patch.dict("os.environ", {"GPU_WORKER_URL": ""}), patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "transcribe", transcribe), patch.object(worker, "ffmpeg", ffmpeg):
            state = await self.run_job("replacement-finish", {"subtitleMethod": "audio-after-generation", "subtitles": [{"start": 0, "end": 1, "text": "错误OCR"}]})
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["segments"], captions)
        self.assertEqual(transcribe.call_args.args[1], worker.MEDIA / "source.mp4")

    async def test_editable_finish_restores_audio_without_burning_or_transcribing(self):
        async def ffmpeg(identifier, *args):
            self.assertIn("-map", args)
            self.assertNotIn("-vf", args)
            self.assertIn("libx264", args)
            args[-1].write_bytes(b"clean-with-audio")
        with patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "transcribe", AsyncMock(side_effect=AssertionError("recognition is a separate step"))), patch.object(worker, "ffmpeg", ffmpeg):
            state = await self.run_job("replacement-finish", {"subtitleMethod": "audio-after-generation", "subtitleOutput": "editable"})
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["segments"], [])
        self.assertEqual(state["result"]["metadata"]["subtitleOutput"], "editable")
        self.assertEqual((worker.MEDIA / state["result"]["file"]).read_bytes(), b"clean-with-audio")

    async def test_postprocessing_keeps_generated_canvas_when_source_ratio_differs(self):
        source = {**self.info, "duration": 10, "fps": 30, "size": (544, 960)}
        generated = {**source, "size": (720, 1280)}
        captions = [{"start": 0.2, "end": 1.5, "text": "校对字幕"}]
        async def probe(identifier, path):
            return source if path.name == "source.mp4" else generated
        async def ffmpeg(identifier, *args):
            self.assertFalse(any("scale=" in str(arg) for arg in args))
            args[-1].write_bytes(b"processed")
        for operation, options in (
            ("replacement-finish", {"subtitleMethod": "audio-after-generation", "subtitleOutput": "editable"}),
            ("replacement-render-captions", {"subtitles": captions}),
        ):
            with self.subTest(operation=operation), patch.object(worker, "probe_video", probe), patch.object(worker, "ffmpeg", ffmpeg), patch.object(worker, "transcribe", AsyncMock(side_effect=AssertionError("must reuse generated video"))):
                state = await self.run_job(operation, options)
            self.assertEqual(state["status"], "completed", state)
    async def test_online_caption_recognition_returns_clean_timeline_from_source_audio(self):
        captions = [{"start": 0.2, "end": 1.5, "text": "请校对这句话。"}]
        transcribe = AsyncMock(return_value=captions)
        with patch.dict("os.environ", {"GPU_WORKER_URL": ""}), patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "transcribe", transcribe):
            state = await self.run_job("replacement-transcribe", {})
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["segments"], captions)
        self.assertEqual(transcribe.call_args.args[1], worker.MEDIA / "source.mp4")

    async def test_caption_render_uses_saved_timeline_and_style(self):
        captions = [{"start": 0.2, "end": 1.5, "text": "已校对的字幕"}]
        async def ffmpeg(identifier, *args):
            self.assertIn("ass=", args[args.index("-vf") + 1])
            args[-1].write_bytes(b"captioned")
        with patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "ffmpeg", ffmpeg):
            state = await self.run_job("replacement-render-captions", {"subtitles": captions, "subtitleBottom": 0.12, "subtitleFont": "Noto Sans CJK SC"})
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["segments"], captions)
        self.assertEqual(state["result"]["metadata"]["subtitleOutput"], "burned-in")

    def test_subtitle_file_uses_requested_safe_font_and_position(self):
        target = self.root / "captions.ass"
        worker.write_subtitles(target, [{"start": 0, "end": 1, "text": "字幕"}], {"subtitleFont": "Noto Sans CJK SC", "subtitleBottom": 0.1}, (720, 1280))
        self.assertIn("Style: Default,Noto Sans CJK SC,42.0", target.read_text(encoding="utf-8-sig"))
        self.assertIn(",2,20,20,128,1", target.read_text(encoding="utf-8-sig"))
        worker.write_subtitles(target, [{"start": 0, "end": 1, "text": "字幕"}], {}, (720, 1280))
        self.assertIn(",2,20,20,30,1", target.read_text(encoding="utf-8-sig"))

    async def test_caption_render_rejects_overlap_without_encoding(self):
        captions = [{"start": 0, "end": 2, "text": "一句"}, {"start": 1, "end": 3, "text": "重叠"}]
        with patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "ffmpeg", AsyncMock(side_effect=AssertionError("must not encode invalid captions"))):
            state = await self.run_job("replacement-render-captions", {"subtitles": captions})
        self.assertEqual(state["status"], "failed", state)
        self.assertIn("重叠", state["error"])

    async def test_no_audio_and_empty_asr_fail_without_deleting_generated_media(self):
        for audio in (False, True):
            with patch.dict("os.environ", {"GPU_WORKER_URL": ""}), patch.object(worker, "probe_video", AsyncMock(return_value={**self.info, "audio": audio})), patch.object(worker, "transcribe", AsyncMock(return_value=[])):
                state = await self.run_job("replacement-finish", {"subtitleMethod": "audio-after-generation"})
            self.assertEqual(state["status"], "failed")
            self.assertIn("音轨", state["error"])
            self.assertTrue((worker.MEDIA / "generated.mp4").exists())

    async def test_legacy_finish_does_not_transcribe_or_change_saved_subtitles(self):
        captions = [{"start": 0, "end": 2, "text": "已保存字幕"}]
        async def ffmpeg(identifier, *args):
            args[-1].write_bytes(b"final")
        with patch.object(worker, "probe_video", AsyncMock(return_value=self.info)), patch.object(worker, "transcribe", AsyncMock(side_effect=AssertionError("must not transcribe old job"))), patch.object(worker, "ffmpeg", ffmpeg):
            state = await self.run_job("replacement-finish", {"subtitles": captions})
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["segments"], captions)

    async def test_remote_worker_receives_method_and_returns_final_transcript(self):
        requests = []
        captions = [{"start": 0, "end": 1, "text": "原音轨"}]
        def respond(request):
            if request.url.path == "/media":
                return httpx.Response(200, json={"id": "remote-source"})
            if request.url.path == "/jobs":
                body = json.loads(request.content)
                requests.append(body)
                result = {"segments": captions} if body["operation"] == "transcribe" else {"file": "clean.mp4", "segments": [], "metadata": body["options"]}
                return httpx.Response(200, json={"status": "completed", "result": result})
            return httpx.Response(200, content=b"clean")
        factory = httpx.AsyncClient
        with patch.dict("os.environ", {"GPU_WORKER_URL": "http://remote"}), patch.object(remote_subtitles.httpx, "AsyncClient", lambda **kwargs: factory(transport=httpx.MockTransport(respond), **kwargs)):
            work = self.root / "prepare"
            work.mkdir()
            output, _ = await remote_subtitles.prepare(worker.MEDIA / "source.mp4", work, lambda _: None, {"subtitleMethod": "audio-after-generation"})
            self.assertEqual(output.read_bytes(), b"clean")
            work = self.root / "finish"
            work.mkdir()
            self.assertEqual(await remote_subtitles.transcribe(worker.MEDIA / "source.mp4", work, lambda _: None), captions)
        self.assertEqual(requests[0]["options"], {"subtitleMethod": "audio-after-generation"})
        self.assertEqual(requests[1]["operation"], "transcribe")


if __name__ == "__main__":
    unittest.main()
