"""Conservative speech/OCR matching. Scene text is never removed by position alone."""
import math
import unicodedata


def normalize_text(value):
    return "".join(c for c in unicodedata.normalize("NFKC", str(value)).casefold() if c.isalnum())


def spoken_texts(segments, time):
    return [normalize_text(s["text"]) for s in segments if float(s["start"]) <= time < float(s["end"])]


def matched_ocr_indices(texts, segments, time):
    spoken = spoken_texts(segments, time)
    normalized = [normalize_text(t) for t in texts]
    # A single character or duplicated wording can also be a shop sign or logo.
    return [i for i, text in enumerate(normalized) if len(text) > 1 and normalized.count(text) == 1 and any(text in line for line in spoken)]


def validate_segments(segments):
    if not isinstance(segments, list):
        raise ValueError("字幕时间轴必须是数组")
    for segment in segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            raise ValueError("字幕内容格式不正确")
        start, end = float(segment["start"]), float(segment["end"])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or not str(segment["text"]).strip():
            raise ValueError("字幕时间轴不正确")


