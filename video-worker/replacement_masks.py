"""Reject incomplete masks, then paste the generated subject onto the source.

Two rules decide every pixel, and both come from how the models actually behave:

1. Inside the new subject, take the generated frame outright. The model painted
   a whole subject; a soft edge across it mixes the model's hair into the old
   hair and reads as a haze. Wan 2.2's own replacement preprocessing pads the
   mask outward for exactly this reason ("a smaller, finer-contoured mask ... can
   lead to some shape leakage"), and ProPainter/E2FGVI composite with dilated
   hard masks, not feathers.
2. Outside it, take the source. Person models repaint the whole frame, so their
   background drifts; blending any of it in is what produces a halo ring around
   the subject and moves trees, railings and sky.

The boundary itself comes from the mask tracked on the GENERATED video when one
is available. The mask tracked on the source hugs the old silhouette, and a
tracker that leaks a little sky above the head would then paste that sky from
the generated frame. A burned-in caption on top of the subject is restored from
the source so the model cannot erase it.
"""
import numpy as np
from PIL import Image, ImageChops, ImageFilter

# A pixel counts as "the model redrew this" past this mean channel difference.
# Only the single-mask path still uses this heuristic.
SUBJECT_THRESHOLD = 40
# Only changed pixels this close to the tracked mask join it, so remote edits
# the model made to the background are not pulled into the person.
SUBJECT_RADIUS = 8
# A growth beyond this multiple of the tracked area means the model changed
# most of the frame; stop instead of publishing a full-frame replacement.
SUBJECT_MAX_GROWTH = 1.5
# Feather as a fraction of the frame width, used only when the caller asks for a
# soft edge. Measured on a real recap: 1.5% of the width (7px) mixed old hair and
# new sky into a crescent belonging to neither frame, and the delivered edge was
# 14% softer than the model's own output. The default is now a hard edge.
FEATHER_RATIO = 0.015
# Outward growth applied to the subject boundary. Wan 2.2's own replacement
# preprocessing dilates its mask (7x7 kernel, 3 iterations ~ 9px) before handing
# it to the model; the generation needs room for hair and a slightly wider body.
# Two measured pixels is enough to cover an anti-aliased silhouette without
# pulling a visible strip of the model's drifted background in.
SUBJECT_EDGE_GROW = 2
# A sub-pixel feather on a hard edge, measured: it removes the stair steps the
# segmentation boundary leaves without reintroducing a blend wide enough to
# carry the old subject's colours.
SUBJECT_EDGE_BLUR = 1
# Caption strokes are thin bright or dark structures; a wide blur removes them
# from the reference and the difference is what is left.
STROKE_BLUR_RATIO = 0.02
STROKE_THRESHOLD = 45
STROKE_GROW = 2


def validate_mask_frames(frames, expected_count, size, allow_full=False):
    if expected_count <= 0 or len(frames) != expected_count or [path.stem for path in frames] != [f"{index:08d}" for index in range(1, expected_count + 1)]:
        raise ValueError("编辑掩膜没有覆盖完整视频，已停止生成")
    for index, path in enumerate(frames):
        with Image.open(path) as image:
            if image.size != tuple(size):
                raise ValueError("编辑掩膜画幅与原视频不一致，已停止生成")
            mask = image.convert("L").point(lambda value: 255 if value > 127 else 0)
            low, high = mask.getextrema()
            if high == 0 or (low == 255 and not allow_full):
                raise ValueError(f"第 {index + 1} 帧编辑区域为空或覆盖整幅画面，已停止局部替换，请平台核查跟踪结果")
    return {"maskFrames": len(frames), "maskChecked": True}


def _shift(mask, offset, axis):
    out = np.zeros_like(mask)
    if offset == 0:
        return mask.copy()
    if axis == 0:
        if offset > 0:
            out[offset:, :] = mask[:-offset, :]
        else:
            out[:offset, :] = mask[-offset:, :]
    elif offset > 0:
        out[:, offset:] = mask[:, :-offset]
    else:
        out[:, :offset] = mask[:, -offset:]
    return out


def _dilate(mask, radius):
    """Square-window dilation built from shifts, so no SciPy is required.

    Done as a horizontal pass then a vertical pass: dilating one axis at a time
    with the accumulated result yields a square window, while a single cross pass
    would leave diagonal notches.
    """
    if radius <= 0:
        return mask.copy()
    horizontal = mask.copy()
    for offset in range(1, radius + 1):
        horizontal |= _shift(mask, offset, 1) | _shift(mask, -offset, 1)
    grown = horizontal.copy()
    for offset in range(1, radius + 1):
        grown |= _shift(horizontal, offset, 0) | _shift(horizontal, -offset, 0)
    return grown


def grow_mask_to_subject(mask, original, generated, threshold=None, radius=None, max_growth=None):
    """Extend the tracked mask onto the pixels the model actually redrew.

    ``mask``/``original``/``generated`` are same-size arrays or images. Raises
    when the change covers far more than the subject, which would mean the model
    repainted the frame and a masked composite is no longer meaningful.
    """
    threshold = SUBJECT_THRESHOLD if threshold is None else threshold
    radius = SUBJECT_RADIUS if radius is None else radius
    max_growth = SUBJECT_MAX_GROWTH if max_growth is None else max_growth
    original = np.asarray(original, dtype=np.int16)
    generated = np.asarray(generated, dtype=np.int16)
    difference = np.abs(generated - original).mean(axis=2)
    combined = mask | ((difference > threshold) & _dilate(mask, radius))
    tracked = int(mask.sum())
    grown = int(combined.sum())
    if tracked and grown > max_growth * tracked:
        raise ValueError("生成画面改动区域远超人物跟踪范围，已停止合成，请平台核查跟踪结果")
    return combined


def _stroke_pixels(gray, boxes, blur, threshold, grow):
    """Thin high-contrast structures inside the caption boxes, grown to cover outlines."""
    edges = np.asarray(ImageChops.difference(gray, gray.filter(ImageFilter.GaussianBlur(blur)))) > threshold
    if not boxes:
        return np.zeros(edges.shape, dtype=bool)
    keep = np.zeros(edges.shape, dtype=bool)
    for left, top, right, bottom in boxes:
        keep[int(top):int(bottom), int(left):int(right)] = True
    return _dilate(edges & keep, grow)


def composite_masked_frames(originals, generated, masks, output_dir, size, feather=None, protect=None,
                            grow=True, threshold=None, radius=None, max_growth=None, secondary=None,
                            edge_grow=None):
    """Paste the generated subject onto the source with a hard boundary.

    ``grow`` extends the tracked mask onto the pixels the model actually redrew
    when no ``secondary`` mask is given. ``secondary`` is an optional per-frame
    mask tracked on the GENERATED video; it becomes the subject boundary, which
    is where the new person actually is. ``protect`` is an optional per-frame
    list of caption boxes whose glyph pixels are restored from the source, so a
    caption drawn on top of the subject survives.

    ``feather`` widens the edge into a blend. It defaults to a hard edge, and a
    caller that passes a positive value is choosing to mix the two frames.
    """
    from pathlib import Path

    originals, generated, masks = map(list, (originals, generated, masks))
    expected = len(originals)
    if expected <= 0 or len(generated) != expected or len(masks) != expected:
        raise ValueError("原画面、生成画面与人物掩膜帧数不一致，已停止合成")
    if secondary is not None and len(list(secondary)) != expected:
        raise ValueError("新人物掩膜与原画面帧数不一致，已停止合成")
    width, height = size
    if feather is None:
        feather = 0
    edge_grow = SUBJECT_EDGE_GROW if edge_grow is None else edge_grow
    stroke_blur = max(3, round(width * STROKE_BLUR_RATIO))
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output = []
    for index, (original_path, generated_path, mask_path) in enumerate(zip(originals, generated, masks), 1):
        with Image.open(original_path) as original_file, Image.open(generated_path) as generated_file, Image.open(mask_path) as mask_file:
            original = original_file.convert("RGB")
            if original.size != tuple(size):
                raise ValueError(f"第 {index} 帧原画面尺寸异常，已停止合成")
            generated = generated_file.convert("RGB").resize(tuple(size), Image.Resampling.LANCZOS)
            if mask_file.size != tuple(size):
                raise ValueError(f"第 {index} 帧人物掩膜尺寸不匹配，已停止合成")
            tracked = np.asarray(mask_file.convert("L")) > 127
            low, high = mask_file.convert("L").getextrema()
            if high == 0 or low == 255:
                raise ValueError(f"第 {index} 帧人物掩膜为空或覆盖整幅画面，已停止合成")
            if secondary is not None:
                with Image.open(list(secondary)[index - 1]) as secondary_file:
                    if secondary_file.size != tuple(size):
                        raise ValueError(f"第 {index} 帧新人物掩膜尺寸不匹配，已停止合成")
                    subject = np.asarray(secondary_file.convert("L")) > 127
                if not subject.any():
                    raise ValueError(f"第 {index} 帧新人物掩膜为空，已停止合成，请平台核查跟踪结果")
                # The new subject's own outline is the boundary, plus whatever part of
                # the OLD outline the model actually erased. Adding the whole old mask
                # would re-import sky the tracker leaked above the head: measured on a
                # real clip those leaked pixels barely changed, while erased old hair
                # and clothing differ by a median of 70-127/255. A pixel of the old
                # mask is kept only where the model clearly replaced its content.
                erased = (np.abs(np.asarray(generated, dtype=np.int16) - np.asarray(original, dtype=np.int16)).mean(axis=2)
                          > (SUBJECT_THRESHOLD if threshold is None else threshold))
                boundary = subject | (tracked & erased)
            else:
                boundary = grow_mask_to_subject(tracked, original, generated, threshold, radius, max_growth) if grow else tracked
            alpha = Image.fromarray((_dilate(boundary, edge_grow) * 255).astype(np.uint8))
            if feather > 0:
                alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
            elif SUBJECT_EDGE_BLUR > 0:
                alpha = alpha.filter(ImageFilter.GaussianBlur(SUBJECT_EDGE_BLUR))
            result = Image.composite(generated, original, alpha)
            boxes = protect[index - 1] if protect and index - 1 < len(protect) else []
            if boxes:
                strokes = _stroke_pixels(original.convert("L"), boxes, stroke_blur, STROKE_THRESHOLD, STROKE_GROW)
                if strokes.any():
                    canvas = np.asarray(result).copy()
                    canvas[strokes] = np.asarray(original)[strokes]
                    result = Image.fromarray(canvas)
            path = output_dir / f"{index:08d}.png"
            result.save(path)
            output.append(path)
    return output
