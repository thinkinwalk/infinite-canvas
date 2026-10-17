"""Reject incomplete masks, then blend the generated subject onto the source.

The tracked mask follows the ORIGINAL subject, but person models redraw a
subject whose silhouette can differ (wider shoulders, longer hair, a different
garment). Keeping generated pixels only inside the tracked mask crops the new
subject and leaves the old outline behind, which reads as a ghost around the
person. The blend therefore grows the mask onto the pixels the model clearly
changed, then feathers the result. A burned-in caption that sits on top of the
subject is taken from the source so the model cannot erase it.
"""
import numpy as np
from PIL import Image, ImageChops, ImageFilter

# A pixel counts as "the model redrew this" past this mean channel difference.
# Uniform background areas of a real clip measured ~2.5/255, so this is far
# above encoder noise while still catching a garment or a limb.
SUBJECT_THRESHOLD = 40
# Only changed pixels this close to the tracked mask join it, so remote edits
# the model made to the background are not pulled into the person.
SUBJECT_RADIUS = 8
# A growth beyond this multiple of the tracked area means the model changed
# most of the frame; stop instead of publishing a full-frame replacement.
SUBJECT_MAX_GROWTH = 1.5
# Feather as a fraction of the frame width: a 2px seam on a 480px frame is a
# hard edge, ~7px blends the new subject into the source.
FEATHER_RATIO = 0.015
# Outward growth applied to the old∪new subject union. The two tracked outlines
# hug the subject, so the remaining ghost is the hairline seam along them;
# measured on a real clip, 2px removed ~77% of it with no background pulled in.
SUBJECT_EDGE_GROW = 2
# The model repaints far more than the subject, so a feathered edge can blend
# old dark hair into bright sky and leave a grey crescent that belongs to
# neither frame. Video inpainting projects (ProPainter, E2FGVI) avoid this by
# using a dilated HARD mask instead of a soft one. Where the model clearly
# changed a pixel this close to the subject, take the generated frame outright
# and re-soften only its outer rim, so no blend crosses two different contents.
SUBJECT_REPAINT_THRESHOLD = 40
SUBJECT_REPAINT_RADIUS = 16
SUBJECT_RIM_BLUR = 2
# A real Wan-Animate frame expanded the subject region to ~1.29x its union mask;
# beyond 1.4x the model repainted the frame and the hard region is not trusted.
SUBJECT_REPAINT_MAX_GROWTH = 1.4
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
                            repaint_threshold=None, repaint_growth=None):
    """Keep the source frame outside the tracked edit area.

    ``grow`` extends the tracked mask onto the pixels the model actually redrew,
    so a new subject wider than the original silhouette is not cropped. ``secondary``
    is an optional per-frame second mask tracked on the GENERATED video; where the
    new subject sits outside the original silhouette this carries the correct
    boundary that pixel difference cannot separate from a repainted background.
    ``protect`` is an optional per-frame list of caption boxes whose glyph pixels
    are restored from the source, so a caption drawn on top of the subject survives.
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
        feather = max(2, round(width * FEATHER_RATIO))
    if repaint_threshold is None and secondary is not None:
        repaint_threshold = SUBJECT_REPAINT_THRESHOLD
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
            combined = tracked
            if secondary is not None:
                secondary_path = list(secondary)[index - 1]
                with Image.open(secondary_path) as secondary_file:
                    if secondary_file.size != tuple(size):
                        raise ValueError(f"第 {index} 帧新人物掩膜尺寸不匹配，已停止合成")
                    new_subject = np.asarray(secondary_file.convert("L")) > 127
                if not new_subject.any():
                    raise ValueError(f"第 {index} 帧新人物掩膜为空，已停止合成，请平台核查跟踪结果")
                # The tracked outlines follow the old and new subject closely, so the
                # ghost is the seam along them. Two measured pixels of outward growth
                # removed ~77% of it on a real clip with no background pulled in.
                combined = _dilate(combined | new_subject, SUBJECT_EDGE_GROW)
            # With a real segmentation of the new subject the union is already the
            # right boundary, so the pixel-difference heuristic is skipped.
            if grow and secondary is None:
                combined = grow_mask_to_subject(combined, original, generated, threshold, radius, max_growth)
            alpha = Image.fromarray((combined * 255).astype(np.uint8))
            if feather > 0:
                alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
            if secondary is not None and repaint_threshold is not None:
                # Take the generated frame outright where the model visibly repainted
                # right next to the subject, then re-soften only the outer rim. See
                # SUBJECT_REPAINT_THRESHOLD: a feathered blend of old hair and new sky
                # produces a grey crescent that neither frame contains. The change test
                # alone would also swallow a distant cloud the model redrew, so the
                # region is clipped to a narrow band around the subject.
                repainted = (np.abs(np.asarray(generated, dtype=np.int16) - np.asarray(original, dtype=np.int16)).mean(axis=2)
                             > repaint_threshold) & _dilate(combined, SUBJECT_REPAINT_RADIUS)
                reached = combined | repainted
                # A model that repainted the whole frame must not turn this into a
                # full-frame switch; keep the feathered mask and add nothing.
                limit = combined.sum() * (repaint_growth or SUBJECT_REPAINT_MAX_GROWTH)
                if reached.sum() <= limit:
                    hard = Image.fromarray((reached * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
                    hard = hard.filter(ImageFilter.GaussianBlur(SUBJECT_RIM_BLUR))
                    alpha = Image.fromarray(np.maximum(np.asarray(alpha), np.asarray(hard)))
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
