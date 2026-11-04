import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from PIL import Image

import app as worker


class VoiceReferencePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_text_subtitle_track_skips_ocr_and_speech_recognition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, audio = root / "source.mp4", root / "sample.wav"
            source.touch()
            audio.touch()
            work = root / "job"
            work.mkdir()

            async def ffmpeg(_, *args):
                Path(args[-1]).write_text("1\n00:00:00,000 --> 00:00:01,000\n這是影片字幕\n", encoding="utf-8")

            with patch.object(worker, "FFPROBE", "/ffprobe"), \
                 patch.object(worker, "command", AsyncMock(return_value=(json.dumps({"streams": [
                     {"index": 2, "codec_type": "subtitle", "codec_name": "subrip", "disposition": {"default": 1}}
                 ]}), ""))), \
                 patch.object(worker, "ffmpeg", ffmpeg), \
                 patch.object(worker, "update_job"), \
                 patch.object(worker, "transcribe_audio", AsyncMock(side_effect=AssertionError("ASR should be skipped"))), \
                 patch.object(worker, "capabilities", side_effect=AssertionError("OCR should be skipped")):
                result = await worker.voice_reference_transcript("job", source, audio, 0, 3, work)

        self.assertEqual(result, ("这是影片字幕", "subtitle-track"))

    async def test_burned_in_subtitles_skip_speech_recognition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, audio = root / "source.mp4", root / "sample.wav"
            source.touch()
            audio.touch()
            work = root / "job"
            work.mkdir()

            async def ffmpeg(_, *args):
                output = Path(args[-1])
                if output.suffix == ".png":
                    for name in ("0001.png", "0002.png"):
                        Image.new("RGB", (1000, 1000)).save(output.parent / name)

            async def command(_, args):
                if args[0] == "/ffprobe":
                    return json.dumps({"streams": []}), ""
                output = Path(args[-1])
                text = json.dumps({"file": "0001.png", "items": [
                    {"rec_texts": ["畫面字幕"], "rec_polys": [[[260, 760], [620, 760], [620, 796], [260, 796]]]}
                ]}, ensure_ascii=False)
                output.write_text(text + "\n" + text.replace("0001.png", "0002.png"), encoding="utf-8")
                return "", ""

            with patch.object(worker, "FFPROBE", "/ffprobe"), \
                 patch.object(worker, "command", command), \
                 patch.object(worker, "ffmpeg", ffmpeg), \
                 patch.object(worker, "update_job"), \
                 patch.object(worker, "capabilities", return_value=[{"name": "ocr", "available": True}]), \
                 patch.object(worker, "transcribe_audio", AsyncMock(side_effect=AssertionError("ASR should be skipped"))):
                result = await worker.voice_reference_transcript("job", source, audio, 0, 3, work)

        self.assertEqual(result, ("画面字幕", "burned-in-subtitle"))

    async def test_missing_subtitles_falls_back_to_simplified_speech_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, audio = root / "source.mp4", root / "sample.wav"
            source.touch()
            audio.touch()
            work = root / "job"
            work.mkdir()
            with patch.object(worker, "FFPROBE", "/ffprobe"), \
                 patch.object(worker, "command", AsyncMock(return_value=(json.dumps({"streams": []}), ""))), \
                 patch.object(worker, "update_job"), \
                 patch.object(worker, "capabilities", return_value=[{"name": "ocr", "available": False}]), \
                 patch.object(worker, "transcribe_audio", AsyncMock(return_value=[{"text": "這是語音原文"}])):
                result = await worker.voice_reference_transcript("job", source, audio, 0, 3, work)

        self.assertEqual(result, ("这是语音原文", "speech"))


if __name__ == "__main__":
    unittest.main()
