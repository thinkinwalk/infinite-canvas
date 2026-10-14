"""Isolate Paddle native inference; release OCR memory before loading LaMa."""
import argparse
import json
from pathlib import Path

from paddleocr import PaddleOCR

parser = argparse.ArgumentParser()
parser.add_argument("--frames", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
# oneDNN PIR conversion fails with the installed Paddle CPU runtime.
ocr = PaddleOCR(use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)
with Path(args.output).open("w", encoding="utf-8") as destination:
    for image in sorted(Path(args.frames).glob("*.png")):
        if image.stem.endswith("_mask"):
            continue
        items = []
        for prediction in ocr.predict(str(image)):
            items.append({"rec_texts": list(prediction.get("rec_texts", [])), "rec_polys": [[[float(v) for v in point] for point in polygon] for polygon in prediction["rec_polys"]]})
        destination.write(json.dumps({"file": image.name, "items": items}, ensure_ascii=False) + "\n")
        destination.flush()
