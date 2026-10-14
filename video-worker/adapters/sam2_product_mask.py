"""Propagate one operator-selected product box through a video with SAM 2."""
import argparse
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor

parser = argparse.ArgumentParser()
parser.add_argument("--config", required=True)
parser.add_argument("--checkpoint", required=True)
parser.add_argument("--frames", required=True)
parser.add_argument("--box", required=True, help="normalized x,y,width,height")
parser.add_argument("--frame", required=True, type=int)
parser.add_argument("--output", required=True)
args = parser.parse_args()

frames = sorted(Path(args.frames).glob("*.jpg"))
if not frames or [frame.stem for frame in frames] != [f"{index:08d}" for index in range(1, len(frames) + 1)]:
    raise ValueError("SAM 2 输入帧缺失或编号不连续")
if not 0 <= args.frame < len(frames):
    raise ValueError("选取的产品画面不在视频时间轴内")
region = [float(value) for value in args.box.split(",")]
if len(region) != 4 or not all(np.isfinite(value) for value in region):
    raise ValueError("产品框坐标无效")
x, y, width, height = region
if min(region) < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
    raise ValueError("产品框必须位于画面内")
with Image.open(frames[0]) as image:
    frame_width, frame_height = image.size
box = np.asarray([x * frame_width, y * frame_height, (x + width) * frame_width, (y + height) * frame_height], dtype=np.float32)
predictor = build_sam2_video_predictor(args.config, args.checkpoint, device="cuda" if torch.cuda.is_available() else "cpu")
state = predictor.init_state(video_path=str(Path(args.frames).resolve()), offload_video_to_cpu=True, offload_state_to_cpu=True)
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
seen = set()

with torch.inference_mode():
    predictor.add_new_points_or_box(state, frame_idx=args.frame, obj_id=1, box=box)
    for reverse in (False, True):
        for frame_index, object_ids, logits in predictor.propagate_in_video(state, start_frame_idx=args.frame, reverse=reverse):
            if 1 not in object_ids:
                raise RuntimeError("SAM 2 跟踪丢失了所选商品")
            mask = (logits[object_ids.index(1), 0] > 0).to("cpu").numpy()
            if not mask.any() or mask.all():
                raise RuntimeError(f"SAM 2 在第 {frame_index + 1} 帧无法可靠分割商品，未启动生成")
            Image.fromarray(mask.astype(np.uint8) * 255).save(output / f"{frame_index + 1:08d}.png")
            seen.add(frame_index)

predictor.reset_state(state)
if seen != set(range(len(frames))):
    raise RuntimeError("SAM 2 未覆盖完整视频时间轴，未启动生成")
