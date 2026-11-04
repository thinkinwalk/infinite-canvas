import html
import re
from statistics import median

from opencc import OpenCC

from subtitle_matching import normalize_text

_simplified = OpenCC("t2s")
_TEXT_SUBTITLE_CODECS = {
    "ass", "ssa", "subrip", "mov_text", "webvtt", "text", "sami",
    "microdvd", "jacosub", "realtext",
}


def simplify_text(value):
    return _simplified.convert(str(value))


def text_subtitle_stream(streams):
    candidates = [
        stream for stream in streams
        if stream.get("codec_type") == "subtitle"
        and stream.get("codec_name") in _TEXT_SUBTITLE_CODECS
    ]
    return next((stream for stream in candidates if stream.get("disposition", {}).get("default")), None) or next(iter(candidates), None)


def parse_srt(value):
    rows = []
    for block in re.split(r"\r?\n\s*\r?\n", value.strip()):
        lines = block.splitlines()
        text_lines = [line for line in lines if "-->" not in line and not line.strip().isdigit()]
        text = re.sub(r"<[^>]*>", "", html.unescape(" ".join(text_lines))).strip()
        if text:
            rows.append(simplify_text(text))
    return "\n".join(rows)


def extract_burned_subtitles(ocr_frames, size):
    width, height = size
    candidates = []
    for frame, predictions in enumerate(ocr_frames):
        rows = []
        for prediction in predictions:
            for text, polygon in zip(prediction.get("rec_texts", []), prediction.get("rec_polys", [])):
                if not polygon or not normalize_text(text):
                    continue
                xs = [float(point[0]) for point in polygon]
                ys = [float(point[1]) for point in polygon]
                left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
                box_height = bottom - top
                if (bottom < height * 0.67 or not width * 0.18 <= (left + right) / 2 <= width * 0.82
                        or not height * 0.012 <= box_height <= height * 0.24
                        or right - left < box_height * 1.15):
                    continue
                rows.append({"frame": frame, "text": simplify_text(text.strip()), "cx": (left + right) / 2,
                             "cy": (top + bottom) / 2, "height": box_height})
        candidates.extend(sorted(rows, key=lambda row: (row["cy"], row["cx"])))

    lanes = []
    for row in candidates:
        lane = next((items for items in lanes
                     if abs(row["cy"] - median(item["cy"] for item in items)) <= max(height * 0.06, row["height"] * 0.75)
                     and 0.45 <= row["height"] / median(item["height"] for item in items) <= 2.2), None)
        if lane is None:
            lane = []
            lanes.append(lane)
        lane.append(row)
    if not lanes:
        return ""

    def score(lane):
        frames = {row["frame"] for row in lane}
        texts = {normalize_text(row["text"]) for row in lane}
        return len(frames) * 3 + min(len(texts), 8)

    lane = max(lanes, key=score)
    if len({row["frame"] for row in lane}) < 2:
        return ""

    frame_texts = []
    for frame in sorted({row["frame"] for row in lane}):
        text = "".join(row["text"] for row in sorted((row for row in lane if row["frame"] == frame), key=lambda row: row["cx"]))
        key = normalize_text(text)
        if key and (not frame_texts or key != normalize_text(frame_texts[-1])):
            frame_texts.append(text)
    return "\n".join(frame_texts)
