"""Run a locally installed TorchScript LaMa model without changing unmasked pixels."""
import argparse
import os
import shutil
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--frames", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--model", required=True)
args = parser.parse_args()
os.environ["LAMA_MODEL"] = args.model
from simple_lama_inpainting import SimpleLama

frames, output = Path(args.frames), Path(args.output)
output.mkdir(parents=True, exist_ok=True)
model = None
for source in sorted(frames.glob("*.png")):
    if source.stem.endswith("_mask"):
        continue
    with Image.open(source) as original, Image.open(source.with_name(source.stem + "_mask.png")) as raw_mask:
        mask = raw_mask.convert("L")
        if not mask.getbbox():
            shutil.copyfile(source, output / source.name)
            continue
        if model is None:
            model = SimpleLama()
        image = original.convert("RGB")
        # Keep surrounding context while avoiding full-frame CPU inference for a subtitle strip.
        left, top, right, bottom = mask.getbbox()
        context = bottom - top
        box = (max(0, left - context), max(0, top - context), min(image.width, right + context), min(image.height, bottom + context))
        region, region_mask = image.crop(box), mask.crop(box)
        repaired = model(region, region_mask).crop((0, 0, region.width, region.height))
        image.paste(Image.composite(repaired, region, region_mask), box)
        image.save(output / source.name)
