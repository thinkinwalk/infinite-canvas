"""Isolated native speech inference so a runtime failure cannot stop the API."""
import argparse
import ctypes
import json
import os
import sys
from pathlib import Path

runtime_handles = []
if sys.platform == "win32":
    runtime_dir = Path(sys.prefix) / "Scripts"
    if (runtime_dir / "msvcp140.dll").is_file():
        runtime_handles.append(os.add_dll_directory(str(runtime_dir)))
        for name in ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll"]:
            if (runtime_dir / name).is_file():
                runtime_handles.append(ctypes.WinDLL(str(runtime_dir / name)))

from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--device", default="cpu")
parser.add_argument("--compute", default="int8")
args = parser.parse_args()
model = WhisperModel(args.model, local_files_only=True, device=args.device, compute_type=args.compute)
segments, _ = model.transcribe(args.input, vad_filter=True, word_timestamps=True)
result = []
for segment in segments:
    if not segment.text.strip():
        continue
    words = segment.words or []
    if not words:
        result.append({"start": segment.start, "end": segment.end, "text": segment.text.strip()})
        continue
    phrase = []
    for index, word in enumerate(words):
        phrase.append(word)
        if word.word.strip().endswith(("，", ",", "。", ".", "！", "!", "？", "?", "；", ";")) or index == len(words) - 1:
            start, end = phrase[0].start, phrase[-1].end
            if end <= start:
                raise ValueError("语音词级时间轴不正确，请检查转写模型")
            result.append({"start": start, "end": end, "text": "".join(item.word for item in phrase).strip()})
            phrase = []
Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
