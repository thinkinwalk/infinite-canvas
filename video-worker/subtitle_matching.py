"""Conservative speech/OCR matching. Scene text is never removed by position alone."""
import math
import unicodedata
from difflib import SequenceMatcher
from opencc import OpenCC

_simplified = OpenCC("t2s")


def normalize_text(value):
    return "".join(c for c in _simplified.convert(unicodedata.normalize("NFKC", str(value))).casefold() if c.isalnum())


def spoken_texts(segments, time):
    return [normalize_text(s["text"]) for s in segments if float(s["start"]) <= time < float(s["end"])]


def matched_ocr_indices(texts, segments, time):
    spoken = spoken_texts(segments, time)
    normalized = [normalize_text(t) for t in texts]
    # A single character or duplicated wording can also be a shop sign or logo.
    def matches(text, line):
        if text in line:
            return True
        # ASR may mishear a caption's last characters. Require a substantial
        # contiguous anchor; use OCR wording for the final captions, never the guess.
        anchor = SequenceMatcher(None, text, line, autojunk=False).find_longest_match().size
        return anchor >= 4 and anchor / len(text) >= 0.6
    return [i for i, text in enumerate(normalized) if len(text) > 1 and normalized.count(text) == 1 and any(matches(text, line) for line in spoken)]


def validate_segments(segments):
    if not isinstance(segments, list):
        raise ValueError("字幕时间轴必须是数组")
    for segment in segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            raise ValueError("字幕内容格式不正确")
        start, end = float(segment["start"]), float(segment["end"])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or not str(segment["text"]).strip():
            raise ValueError("字幕时间轴不正确")


def overlaps_caption_line(points, lines):
    left, top = min(p[0] for p in points), min(p[1] for p in points)
    right, bottom = max(p[0] for p in points), max(p[1] for p in points)
    for line in lines:
        x1, y1, x2, y2 = line
        if min(right, x2) > max(left, x1) and min(bottom, y2) - max(top, y1) > min(bottom - top, y2 - y1) / 2:
            return True
    return False


