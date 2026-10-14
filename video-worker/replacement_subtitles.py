"""Locate a spoken subtitle band without using its OCR wording as the mask."""

import math
from statistics import median
from opencc import OpenCC

from subtitle_matching import matched_ocr_indices, normalize_text, validate_segments

_simplified = OpenCC("t2s")


def audio_captions(segments, duration):
    validate_segments(segments)
    if not segments:
        raise ValueError("原音轨没有识别到口播，字幕处理已停止；已有生成结果会保留")
    previous_end = 0
    for segment in segments:
        if float(segment["start"]) < previous_end or float(segment["end"]) > duration:
            raise ValueError("语音字幕时间轴重叠、乱序或超出原视频，已停止合成")
        previous_end = float(segment["end"])
    # Keep punctuation and spaces; OCR wording is never used as the transcript.
    return [{**segment, "text": _simplified.convert(segment["text"].strip())} for segment in segments]


def _near_speech(segments, time):
    return any(float(item["start"]) - 0.5 <= time <= float(item["end"]) + 0.5 for item in segments)


def _near_lane(item, lane, height):
    center = median(value["cy"] for value in lane)
    typical_height = median(value["height"] for value in lane)
    return (abs(item["cy"] - center) <= max(height * 0.06, typical_height * 0.75)
            and 0.45 <= item["height"] / typical_height <= 2.2)


def locate_caption_masks(ocr_frames, size, fps, speech):
    """Return padded per-frame boxes, or stop before charging when layout is unclear.

    A changing, lower-screen, screen-fixed text lane is evidence for captions;
    ASR wording is only optional corroboration. Nearby frames cover typing
    animation and intermittent OCR misses. Scene text outside the lane is kept.
    """
    width, height = size
    if not speech:
        raise ValueError("原音轨没有识别到口播，已暂停且未提交收费替换")
    candidates, unclassified = [], []
    for frame, predictions in enumerate(ocr_frames):
        for prediction in predictions:
            for text, polygon in zip(prediction.get("rec_texts", []), prediction["rec_polys"]):
                if not polygon:
                    continue
                xs, ys = [float(p[0]) for p in polygon], [float(p[1]) for p in polygon]
                left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
                box_height = bottom - top
                if (box_height < height * 0.012 or box_height > height * 0.24
                        or not width * 0.18 <= (left + right) / 2 <= width * 0.82):
                    continue
                item = {"frame": frame, "box": (left, top, right, bottom), "height": box_height,
                        "cx": (left + right) / 2, "cy": (top + bottom) / 2, "text": str(text)}
                (candidates if bottom >= height * 0.67 else unclassified).append(item)
    if not candidates:
        return [[] for _ in ocr_frames]

    lanes = []
    for item in sorted((item for item in candidates if normalize_text(item["text"]) and item["box"][2] - item["box"][0] >= item["height"] * 1.15), key=lambda value: value["cy"]):
        lane = next((lane for lane in lanes if _near_lane(item, lane, height)), None)
        if lane is None:
            lane = []
            lanes.append(lane)
        lane.append(item)

    def supported(lane):
        frames = {item["frame"] for item in lane}
        if len(frames) < max(2, math.ceil(fps * 0.2)):
            return False
        if not any(_near_speech(speech, item["frame"] / fps) for item in lane):
            return False
        matches = any(matched_ocr_indices([item["text"]], speech, item["frame"] / fps) for item in lane)
        ordered = sorted(lane, key=lambda item: item["frame"])
        # Typing animation is stronger evidence than unrelated text changing at cuts.
        growth = any(a["frame"] != b["frame"] and normalize_text(b["text"]).startswith(normalize_text(a["text"]))
                     and len(normalize_text(b["text"])) > len(normalize_text(a["text"])) >= 2
                     for a, b in zip(ordered, ordered[1:]))
        return growth or bool(matches)

    strong = [lane for lane in lanes if supported(lane)]
    if len(strong) != 1:
        raise ValueError("无法可靠区分口播字幕与画面文字，已暂停且未提交收费替换，请平台核查素材")
    lane = strong[0]
    # Large text outside the established lane (often opening titles) must not
    # silently pass as a fully cleaned video. Ambiguous layouts need review.
    if any(item["height"] >= median(value["height"] for value in lane) * 0.75
           and item["frame"] < min(value["frame"] for value in lane) for item in unclassified):
        raise ValueError("开头有位于常规字幕区域外的大字，无法可靠区分标题与环境文字，已停止收费生成，请平台核查")
    selected = [[] for _ in ocr_frames]
    for item in candidates:
        if _near_lane(item, lane, height):
            selected[item["frame"]].append(item["box"])
    first, last = min(item["frame"] for item in lane), max(item["frame"] for item in lane)
    for segment in speech:
        start, end = float(segment["start"]), float(segment["end"])
        if end - start < 0.6 or end < first / fps or start > last / fps:
            continue
        if not any(selected[frame] for frame in range(max(0, math.floor((start - 0.3) * fps)), min(len(selected), math.ceil((end + 0.3) * fps)))):
            raise ValueError(f"约 {start:.2f} 秒的口播字幕未能可靠定位，已暂停且未提交收费替换")

    radius = max(1, math.ceil(fps * 0.12))
    masks = []
    for frame in range(len(selected)):
        boxes = []
        for nearby in range(max(0, frame - radius), min(len(selected), frame + radius + 1)):
            for left, top, right, bottom in selected[nearby]:
                pad = (bottom - top) * 0.13
                boxes.append((max(0, left - pad), max(0, top - pad), min(width, right + pad), min(height, bottom + pad)))
        masks.append(boxes)
    return masks
