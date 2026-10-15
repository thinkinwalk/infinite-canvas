"""Reject incomplete masks before starting replacement inference."""
from PIL import Image, ImageFilter


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


def composite_masked_frames(originals, generated, masks, output_dir, size, feather=2):
    """Keep the source frame outside the tracked edit area."""
    from pathlib import Path

    originals, generated, masks = map(list, (originals, generated, masks))
    expected = len(originals)
    if expected <= 0 or len(generated) != expected or len(masks) != expected:
        raise ValueError("原画面、生成画面与人物掩膜帧数不一致，已停止合成")
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
            mask = mask_file.convert("L").point(lambda value: 255 if value > 127 else 0)
            low, high = mask.getextrema()
            if high == 0 or low == 255:
                raise ValueError(f"第 {index} 帧人物掩膜为空或覆盖整幅画面，已停止合成")
            if feather > 0:
                mask = mask.filter(ImageFilter.GaussianBlur(feather))
            path = output_dir / f"{index:08d}.png"
            Image.composite(generated, original, mask).save(path)
            output.append(path)
    return output
