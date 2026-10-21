import asyncio
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

import app as worker


class JobIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_cpu_subtitle_routes_stay_disabled_with_remote_service(self):
        retired = ("subtitle-remove", "replacement-prepare", "replacement-subtitles-v2")
        remote = AsyncMock(return_value={name: True for name in (*retired, "transcribe")})
        with patch.dict("os.environ", {"GPU_WORKER_URL": "http://remote"}), patch.object(worker.remote_subtitles, "capabilities", remote):
            capabilities = {item["name"]: item for item in await worker.available_capabilities()}
        self.assertTrue(all(not capabilities[name]["available"] for name in retired))
        run = AsyncMock()
        with tempfile.TemporaryDirectory() as directory, patch.object(worker, "JOBS", Path(directory)), patch.object(worker, "run_job", run):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker.app), base_url="http://worker", headers={"X-Canvas-Worker": "1"}) as client:
                for operation in retired[:2]:
                    with patch.object(worker, "available_capabilities", AsyncMock(return_value=list(capabilities.values()))):
                        response = await client.post("/jobs", json={"operation": operation, "inputs": {"video": "source.mp4"}})
                    self.assertEqual(response.status_code, 422, response.text)
                    self.assertIn("已下线", response.json()["detail"])
            self.assertEqual(list(Path(directory).iterdir()), [])
        run.assert_not_awaited()

    async def test_audio_restore_does_not_require_retired_subtitle_engines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            media, jobs = root / "media", root / "jobs"
            media.mkdir()
            jobs.mkdir()
            for filename in ("source.mp4", "generated.mp4"):
                (media / filename).write_bytes(b"test")
            tasks = {}
            run = AsyncMock()
            capabilities = [{"name": "replacement-finish", "available": True}]
            with patch.multiple(worker, MEDIA=media, JOBS=jobs, TASKS=tasks), patch.object(worker, "run_job", run), patch.object(worker, "available_capabilities", AsyncMock(return_value=capabilities)):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker.app), base_url="http://worker", headers={"X-Canvas-Worker": "1"}) as client:
                    response = await client.post("/jobs", json={"operation": "replacement-finish", "inputs": {"source": "source.mp4", "video": "generated.mp4"}, "options": {"subtitleMethod": "audio-after-generation", "subtitleOutput": "editable"}})
                self.assertEqual(response.status_code, 200, response.text)
                await asyncio.gather(*tasks.values())
                run.assert_awaited_once()

    async def test_media_inputs_never_replace_job_id_and_recovery_reuses_job(self):
        for inputs in ({"video": "source.mp4"}, {"video": "source.mp4", "parts": ["part-a.mp4", "part-b.mp4"]}):
            for supplied_id in (None, str(uuid.uuid4())):
                with self.subTest(inputs=inputs, supplied_id=supplied_id), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory).resolve()
                    media, jobs = root / "media", root / "jobs"
                    media.mkdir()
                    jobs.mkdir()
                    for filename in ("source.mp4", "part-a.mp4", "part-b.mp4"):
                        (media / filename).write_bytes(b"test media")
                    tasks = {}
                    run = AsyncMock()
                    with patch.multiple(worker, MEDIA=media, JOBS=jobs, TOKEN="", TASKS=tasks), patch.object(worker, "run_job", run), patch.object(worker, "available_capabilities", AsyncMock(return_value=[{"name": "replacement-plan", "available": True}])):
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker.app), base_url="http://worker", headers={"X-Canvas-Worker": "1"}) as client:
                            request = {"operation": "replacement-plan", "inputs": inputs, "options": {"seconds": 15}}
                            if supplied_id:
                                request["id"] = supplied_id
                            response = await client.post("/jobs", json=request)
                            self.assertEqual(response.status_code, 200, response.text)
                            identifier = response.json()["id"]
                            uuid.UUID(identifier)
                            if supplied_id:
                                self.assertEqual(identifier, supplied_id)
                            await asyncio.gather(*tasks.values())
                            run.assert_awaited_once()
                            self.assertEqual(run.call_args.args[0], identifier)
                            self.assertEqual([p.name for p in jobs.iterdir()], [f"{identifier}.json"])
                            self.assertEqual((await client.get(f"/jobs/{identifier}")).json()["id"], identifier)
                            if supplied_id:
                                retry = await client.post("/jobs", json=request)
                                self.assertEqual(retry.status_code, 200, retry.text)
                                self.assertEqual(retry.json()["id"], identifier)
                                self.assertEqual(run.await_count, 1)
                                conflict = await client.post("/jobs", json={**request, "options": {"seconds": 10}})
                                self.assertEqual(conflict.status_code, 409)


if __name__ == "__main__":
    unittest.main()
