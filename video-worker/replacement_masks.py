"""Reject incomplete masks before starting replacement inference."""
from PIL import Image


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
