"""Check upstream replacement preprocessing before loading the generator."""
import math


def validate_wan_materials(processed, source=None):
    import cv2

    counts, rates = [], []
    for name in ("src_pose.mp4", "src_face.mp4", "src_bg.mp4", "src_mask.mp4"):
        path = processed / name
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(f"人物预处理缺少 {name}，未启动替换生成")
        capture = cv2.VideoCapture(str(path))
        count = 0
        try:
            rate = capture.get(cv2.CAP_PROP_FPS)
            declared = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                count += 1
                if name == "src_mask.mp4":
                    mask = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) > 127
                    if not mask.any() or mask.all():
                        raise ValueError(f"第 {count} 帧人物分割为空或覆盖整幅画面，未启动替换生成，请平台核查人物跟踪")
            if count == 0 or declared != count or not math.isfinite(rate) or rate <= 0:
                raise ValueError(f"人物预处理 {name} 视频不完整，未启动替换生成")
            counts.append(count)
            rates.append(rate)
        finally:
            capture.release()
    if len(set(counts)) != 1 or len(set(rates)) != 1:
        raise ValueError("人物姿态、面部、背景与蒙版时间轴不一致，未启动替换生成")
    if source is not None:
        capture = cv2.VideoCapture(str(source))
        try:
            source_rate = capture.get(cv2.CAP_PROP_FPS)
            source_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
            if not math.isfinite(source_rate) or not math.isfinite(source_count) or source_rate <= 0 or source_count <= 0:
                raise ValueError("无法读取原视频时间轴，未启动替换生成")
            if abs(source_count / source_rate - counts[0] / rates[0]) > max(1 / source_rate, 1 / rates[0]):
                raise ValueError("人物预处理没有覆盖原视频时长，未启动替换生成")
        finally:
            capture.release()
