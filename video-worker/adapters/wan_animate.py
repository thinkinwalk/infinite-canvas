"""Run the upstream Wan-Animate preprocessing and replacement commands."""
import argparse
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--weights", required=True)
parser.add_argument("--process-weights", required=True)
parser.add_argument("--video", required=True)
parser.add_argument("--image", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--width", type=int, default=1280)
parser.add_argument("--height", type=int, default=720)
args = parser.parse_args()
repo = Path(args.repo).resolve()
output = Path(args.output).resolve()
processed = output.parent / "wan-materials"
subprocess.run([
    sys.executable, "wan/modules/animate/preprocess/preprocess_data.py",
    "--ckpt_path", args.process_weights, "--video_path", args.video,
    "--refer_path", args.image, "--save_path", str(processed),
    "--resolution_area", str(args.width), str(args.height),
    "--iterations", "3", "--k", "7", "--w_len", "1", "--h_len", "1", "--replace_flag",
], cwd=repo, check=True)
subprocess.run([
    sys.executable, "generate.py", "--task", "animate-14B", "--ckpt_dir", args.weights,
    "--src_root_path", str(processed), "--refert_num", "1", "--replace_flag",
    "--use_relighting_lora", "--save_file", str(output),
], cwd=repo, check=True)
if not output.is_file():
    raise RuntimeError("Wan-Animate 未写入指定输出文件")
