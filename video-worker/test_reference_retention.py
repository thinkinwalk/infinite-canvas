import asyncio
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
import app as worker


class ReferenceRetentionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.media, self.jobs = self.root / "media", self.root / "jobs"
        self.media.mkdir()
        self.jobs.mkdir()
        self.patch = patch.multiple(worker, MEDIA=self.media, JOBS=self.jobs, TOKEN="", TASKS={})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=worker.app), base_url="http://worker", headers={"X-Canvas-Worker": "1"})
        self.addAsyncCleanup(self.client.aclose)
        self.reference = str(uuid.uuid4())

    def managed(self, name):
        path = self.media / name
        path.write_bytes(b"video")
        worker.atomic_json(path.with_suffix(path.suffix + ".json"), {"temporaryReference": self.reference})
        return path

    async def cleanup(self, names):
        response = await self.client.post("/temporary-references/cleanup", json={"referenceId": self.reference, "files": names})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["cleaned"]

    async def test_running_job_blocks_cleanup_then_only_managed_input_is_removed(self):
        original = self.managed("original.mp4")
        derived = self.managed("unregistered-proxy.mp4")
        historical, output = self.media / "old.mp4", self.media / "generated.mp4"
        historical.write_bytes(b"history")
        output.write_bytes(b"result")
        job_id = str(uuid.uuid4())
        record = {"id": job_id, "status": "running", "request": {"inputs": {"video": derived.name}}, "result": {"file": output.name}}
        worker.atomic_json(self.jobs / f"{job_id}.json", record)
        self.assertFalse(await self.cleanup([original.name]))
        self.assertTrue(original.exists())
        record["status"] = "completed"
        worker.atomic_json(self.jobs / f"{job_id}.json", record)
        self.assertTrue(await self.cleanup([original.name]))
        self.assertFalse(original.exists())
        self.assertFalse(derived.exists())
        self.assertTrue(historical.exists())
        self.assertTrue(output.exists())

    async def test_unmanaged_files_wrong_reference_and_unsafe_paths_are_never_deleted(self):
        path = self.managed("managed.mp4")
        old = self.media / "old.mp4"
        old.write_bytes(b"old")
        self.assertFalse(await self.cleanup([path.name, old.name]))
        self.assertTrue(path.exists())
        worker.atomic_json(path.with_suffix(".mp4.json"), {"temporaryReference": str(uuid.uuid4())})
        self.assertFalse(await self.cleanup([path.name]))
        response = await self.client.post("/temporary-references/cleanup", json={"referenceId": self.reference, "files": ["../outside.mp4"]})
        self.assertEqual(response.status_code, 422)
        self.assertTrue(path.exists())

    async def test_unknown_or_corrupt_job_records_fail_closed(self):
        source = self.managed("original.mp4")
        (self.jobs / "broken.json").write_text("{", encoding="utf-8")
        self.assertFalse(await self.cleanup([source.name]))
        self.assertTrue(source.exists())

    async def test_dry_run_checks_without_deleting_media_or_metadata(self):
        source = self.managed("original.mp4")
        details = source.with_suffix(".mp4.json")
        before = details.read_bytes()
        response = await self.client.post("/temporary-references/cleanup", json={"referenceId": self.reference, "files": [source.name], "dryRun": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["cleaned"])
        self.assertTrue(source.exists())
        self.assertEqual(details.read_bytes(), before)

    async def test_analysis_proxy_keeps_portrait_shape_audio_and_original(self):
        source = self.managed("portrait.mp4")
        command = [worker.FFMPEG, "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1080x1920:r=10:d=1",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", str(source)]
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        _, error = await process.communicate()
        self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
        original_size = source.stat().st_size
        job_id = str(uuid.uuid4())
        request = worker.JobRequest(operation="analysis-proxy", inputs={"video": source.name})
        worker.atomic_json(self.jobs / f"{job_id}.json", {"id": job_id, "status": "running", "request": request.model_dump()})
        await worker.run_job(job_id, request)
        job = worker.read_job(job_id)
        self.assertEqual(job["status"], "completed", job.get("error"))
        proxy = self.media / job["result"]["file"]
        info = await asyncio.to_thread(worker.metadata, proxy)
        self.assertEqual(info["size"], (720, 1280))
        self.assertAlmostEqual(info["duration"], 1, delta=0.15)
        self.assertIn("aac", info.get("audio_codec", ""))
        self.assertEqual(source.stat().st_size, original_size)
        self.assertFalse((self.jobs / job_id).exists())
        details = json.loads(proxy.with_suffix(".mp4.json").read_text())
        self.assertEqual(details["temporaryReference"], self.reference)
        response = await self.client.post(f"/media/{proxy.name}/temporary", headers={"X-Video-Reference-ID": self.reference})
        self.assertEqual(response.status_code, 200, response.text)
        trim_id = str(uuid.uuid4())
        trim = worker.JobRequest(operation="trim", inputs={"video": source.name}, options={"start": 0, "end": 1})
        worker.atomic_json(self.jobs / f"{trim_id}.json", {"id": trim_id, "status": "running", "request": trim.model_dump()})
        await worker.run_job(trim_id, trim)
        trimmed = worker.read_job(trim_id)
        self.assertEqual(trimmed["status"], "completed", trimmed.get("error"))
        clip = self.media / trimmed["result"]["file"]
        self.assertEqual(json.loads(clip.with_suffix(".mp4.json").read_text())["temporaryReference"], self.reference)
        self.assertFalse((self.jobs / trim_id).exists())
        for temporary in (True, False):
            compose_id = str(uuid.uuid4())
            compose = worker.JobRequest(operation="compose", inputs={"video": source.name}, options={"referenceCompatibility": temporary})
            worker.atomic_json(self.jobs / f"{compose_id}.json", {"id": compose_id, "status": "running", "request": compose.model_dump()})
            await worker.run_job(compose_id, compose)
            composed = worker.read_job(compose_id)
            self.assertEqual(composed["status"], "completed", composed.get("error"))
            composed_path = self.media / composed["result"]["file"]
            self.assertEqual(composed_path.with_suffix(".mp4.json").exists(), temporary)
        generated = composed_path
        self.assertTrue(await self.cleanup([source.name]))
        self.assertFalse(source.exists())
        self.assertFalse(proxy.exists())
        self.assertFalse(clip.exists())
        self.assertTrue(generated.exists())


if __name__ == "__main__":
    unittest.main()
