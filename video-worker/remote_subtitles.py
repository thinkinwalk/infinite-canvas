"""Delegate the complete subtitle operation to the configured GPU worker.

CPU gateway never extracts all frames or loads OCR/repair weights in this mode.
"""
import asyncio
import json
import os
import uuid

import httpx


def settings():
    return os.environ.get("GPU_WORKER_URL", "").rstrip("/"), {
        "X-Canvas-Worker": "1", "Authorization": "Bearer " + os.environ.get("GPU_WORKER_TOKEN", "")}


async def capabilities():
    base, headers = settings()
    if not base:
        return {}
    try:
        async with httpx.AsyncClient(base_url=base, headers=headers, timeout=None) as client:
            response = await client.get("/health")
            response.raise_for_status()
            return {c["name"]: c["available"] for c in response.json()["capabilities"]}
    except (httpx.HTTPError, ValueError, KeyError):
        return {}


async def run(source, work, update, operation, options):
    base, headers = settings()
    marker = work / "remote-job.json"
    async with httpx.AsyncClient(base_url=base, headers=headers, timeout=None) as client:
        details = json.loads(marker.read_text()) if marker.exists() else {}
        if details and details["url"] != base:
            raise ValueError("远程处理服务发生变化，请恢复原服务后查询已有任务")
        if not details:
            with source.open("rb") as file:
                response = await client.post("/media", files={"file": (source.name, file, "video/mp4")})
            response.raise_for_status()
            details = {"url": base, "id": str(uuid.uuid4()), "video": response.json()["id"]}
            temporary = marker.with_suffix(".tmp")
            temporary.write_text(json.dumps(details), encoding="utf-8")
            temporary.replace(marker)
        try:
            response = await client.post("/jobs", json={"id": details["id"], "operation": operation, "inputs": {"video": details["video"]}, "options": options})
            response.raise_for_status()
            while True:
                state = response.json()
                update(state.get("step", "云端字幕处理"))
                if state["status"] in ("failed", "cancelled"):
                    raise RuntimeError(state.get("error") or "云端字幕处理失败")
                if state["status"] == "completed":
                    result = state["result"]
                    if operation == "transcribe":
                        return result.get("segments", [])
                    if options.get("subtitleMethod") == "audio-after-generation" and result.get("metadata", {}).get("subtitleMethod") != "audio-after-generation":
                        raise ValueError("远程字幕服务未按新流程清理，已停止收费生成，请管理员更新服务")
                    output = work / "clean-subtitles.mp4"
                    async with client.stream("GET", "/media/" + result["file"]) as download:
                        download.raise_for_status()
                        with output.open("wb") as file:
                            async for chunk in download.aiter_bytes():
                                file.write(chunk)
                    return output, result.get("segments", [])
                await asyncio.sleep(5)  # Existing GPU worker polling interval.
                response = await client.get("/jobs/" + details["id"])
                response.raise_for_status()
        except asyncio.CancelledError:
            response = await client.post("/jobs/" + details["id"] + "/cancel")
            response.raise_for_status()
            raise


async def prepare(source, work, update, options=None):
    return await run(source, work, update, "replacement-prepare", options or {})


async def transcribe(source, work, update):
    return await run(source, work, update, "transcribe", {})
