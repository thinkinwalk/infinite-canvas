"""Run upstream VACE with the video, temporal mask and reference images."""
import argparse
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--weights", required=True)
parser.add_argument("--video", required=True)
parser.add_argument("--mask", required=True)
parser.add_argument("--image", required=True)
parser.add_argument("--background", default="")
parser.add_argument("--prompt", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--frames", type=int, required=True)
parser.add_argument("--model", default="vace-1.3B", choices=["vace-1.3B", "vace-14B"])
parser.add_argument("--size", default="480p", choices=["480p", "720p"])
args = parser.parse_args()
if args.frames <= 0 or (args.frames - 1) % 4:
    raise ValueError("VACE 帧数需要符合模型的 4n+1 时间维度")
output = Path(args.output).resolve()
references = ",".join(path for path in [args.image, args.background] if path)
subprocess.run([
    sys.executable, "vace/vace_wan_inference.py", "--ckpt_dir", args.weights,
    "--model_name", args.model, "--size", args.size, "--frame_num", str(args.frames),
    "--src_video", args.video, "--src_mask", args.mask, "--src_ref_images", references,
    "--prompt", args.prompt or "Replace the masked area using the reference image while preserving other content.",
    "--save_file", str(output),
], cwd=Path(args.repo).resolve(), check=True)
if not output.is_file():
    raise RuntimeError("VACE 未写入指定输出文件")
