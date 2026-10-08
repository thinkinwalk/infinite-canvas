"""Delegate an expensive engine operation to another trusted Canvas worker."""
import argparse
import json
import os
import time
from contextlib import ExitStack
from pathlib import Path

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--operation", required=True)
for name in ["video", "image", "mask", "avatar", "audio", "background"]:
    parser.add_argument("--" + name, default="")
parser.add_argument("--replacement", default="person")
parser.add_argument("--prompt", default="")
parser.add_argument("--output", required=True)
args = parser.parse_args()
url = os.environ["GPU_WORKER_URL"].rstrip("/")
headers = {"X-Canvas-Worker": "1"}
if os.environ.get("GPU_WORKER_TOKEN"):
    headers["Authorization"] = "Bearer " + os.environ["GPU_WORKER_TOKEN"]
output = Path(args.output).resolve()
with httpx.Client(base_url=url, headers=headers, timeout=None) as client, ExitStack() as stack:
    inputs = {}
    for name in ["video", "image", "mask", "avatar", "audio", "background"]:
        value = getattr(args, name)
        if not value:
            continue
        file = Path(value)
        stream = stack.enter_context(file.open("rb"))
        mime = "audio/wav" if name == "audio" else "video/mp4" if file.suffix.lower() in (".mp4", ".webm", ".mov") else "image/png"
        response = client.post("/media", files={"file": (file.name, stream, mime)}, data={"metadata": "{}"})
        response.raise_for_status()
        inputs[name] = response.json()["id"]
    options = {"replacement": args.replacement, "prompt": args.prompt}
    response = client.post("/jobs", json={"operation": args.operation, "inputs": inputs, "options": options})
    response.raise_for_status()
    identifier = response.json()["id"]
    (output.parent / "remote-job.json").write_text(json.dumps({"url": url, "id": identifier}), encoding="utf-8")
    while True:
        response = client.get("/jobs/" + identifier)
        response.raise_for_status()
        job = response.json()
        if job["status"] in ("failed", "cancelled"):
            raise RuntimeError(job.get("error") or "远程推理未完成")
        if job["status"] == "completed":
            file = job.get("result", {}).get("file")
            if not file:
                raise RuntimeError("远程推理没有返回视频文件")
            response = client.get("/media/" + file)
            response.raise_for_status()
            output.write_bytes(response.content)
            break
        time.sleep(5)  # Reuses the existing video task polling interval.
