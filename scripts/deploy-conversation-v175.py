import hashlib
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

VERSION = "v0.19.175"
PREVIOUS = "infinite-canvas:v0.19.174"
EXPECTED_SOURCE = sys.argv[1]
assert re.fullmatch(r"[0-9a-f]{40}", EXPECTED_SOURCE)
ROOT = Path("/opt/infinite-canvas")
REPO = Path("/opt/infinite-canvas-repo")
COMPOSE = ROOT / "docker-compose.deploy.yml"
DB = ROOT / "data/infinite-canvas.db"
REPORT = ROOT / "releases" / f"{VERSION}-deployment.json"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def inspect(name):
    return json.loads(run("docker", "inspect", name))[0]


def environment(container):
    return dict(value.split("=", 1) for value in container["Config"]["Env"])


def mounts(container):
    return sorted((m["Type"], m["Source"], m["Destination"], m["RW"], m["Propagation"]) for m in container["Mounts"])


def compose_config():
    return json.loads(run("docker", "compose", "-f", str(COMPOSE), "config", "--format", "json"))


def fetch(path, base="https://studio.lingzhouai.com"):
    with urlopen(base + path, timeout=30) as response:
        assert response.status == 200, (path, response.status)
        return response.read()


def backup(label):
    target = ROOT / "backups" / f"{label}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
    target.mkdir(mode=0o700)
    for name in [".env", "docker-compose.deploy.yml"]:
        shutil.copy2(ROOT / name, target / name)
        (target / name).chmod(0o600)
    source = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    destination = sqlite3.connect(target / "infinite-canvas.db")
    source.backup(destination)
    assert destination.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    source.close()
    destination.close()
    (target / "infinite-canvas.db").chmod(0o600)
    print(f"Verified backup: {target}", flush=True)
    return target


def db_snapshot(connection):
    schema = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
    tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    counts, protected = {}, {}
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        counts[table] = connection.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
        if table == "settings":
            protected[table] = sorted(connection.execute(f"SELECT * FROM {quoted}").fetchall(), key=repr)
        if table == "users":
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({quoted})")}
            fields = [field for field in ["id", "credits", "role", "group", "status", "disabled"] if field in columns]
            protected[table] = sorted(connection.execute("SELECT " + ",".join('"' + field + '"' for field in fields) + f" FROM {quoted}").fetchall(), key=repr)
    return schema, counts, protected


def inactive_tasks():
    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        recoverable = set()
        for path in (ROOT / "data/replacement-jobs").glob("*.json"):
            job = json.loads(path.read_text())
            if job.get("status") == "paused":
                recoverable.update(part["taskId"] for part in job.get("parts", []) if part.get("submitted") and part.get("taskId"))
        for table in ["video_tasks", "replicate_tasks"]:
            for task_id, status in connection.execute(f"SELECT id,status FROM {table}"):
                assert status in ["completed", "failed", "cancelled"] or task_id in recoverable, ("Unpaused cloud task", table, task_id, status)
    finally:
        connection.close()
    hashes = {}
    for directory in [ROOT / "data/replacement-jobs", ROOT / "video-worker-data/jobs"]:
        for path in directory.glob("*.json"):
            data = json.loads(path.read_text())
            status = data.get("status")
            if directory.name == "jobs" and directory.parent.name == "video-worker-data":
                assert status in ["completed", "failed", "cancelled"], "Active Worker job"
            elif status == "planning":
                linked = json.loads((ROOT / "video-worker-data/jobs" / (data["workerId"] + ".json")).read_text())
                assert linked["status"] == "completed" and data.get("workerStep") == "plan", "Active planning job"
            else:
                assert status in ["completed", "failed", "cancelled", "ready", "paused"], ("Active replacement job", status)
            hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def media_snapshot():
    return {str(path): (path.stat().st_size, path.stat().st_mtime_ns)
            for directory in [ROOT / "data", ROOT / "video-worker-data"]
            for path in directory.rglob("*") if path.is_file() and path.suffix != ".json" and not path.name.startswith("infinite-canvas.db")}


assert DB.is_file()
before_app = inspect("infinite-canvas")
before_worker = inspect("infinite-canvas-video-worker")
before_config = compose_config()
assert before_app["Config"]["Image"] == PREVIOUS
assert before_config["services"]["app"]["image"] == PREVIOUS
assert environment(before_app)["DATABASE_DSN"] == "/app/data/infinite-canvas.db"
assert any(m["Source"] == str(ROOT / "data") and m["Destination"] == "/app/data" for m in before_app["Mounts"])
assert fetch("/api/health").strip() == b"ok"
assert run("git", "-C", str(REPO), "status", "--porcelain", "--untracked-files=no") == ""
job_hashes = inactive_tasks()
prebuild = backup(VERSION + "-prebuild")

subprocess.run(["git", "-C", str(REPO), "fetch", "origin", f"refs/tags/{VERSION}:refs/tags/{VERSION}"], check=True)
subprocess.run(["git", "-C", str(REPO), "checkout", "--detach", VERSION], check=True)
source = run("git", "-C", str(REPO), "rev-parse", "HEAD")
assert source == EXPECTED_SOURCE and (REPO / "VERSION").read_text().strip() == VERSION
print(f"Building {VERSION} at {source}", flush=True)
subprocess.run(["docker", "build", "-t", "infinite-canvas:" + VERSION, str(REPO)], check=True)
assert inspect("infinite-canvas")["Id"] == before_app["Id"]
assert compose_config() == before_config
assert inactive_tasks() == job_hashes
final_backup = backup(VERSION + "-final")
old_db = sqlite3.connect(f"file:{final_backup / 'infinite-canvas.db'}?mode=ro", uri=True)
old_schema, old_counts, old_protected = db_snapshot(old_db)
old_db.close()
before_media = media_snapshot()
old_compose = COMPOSE.read_bytes()
old_image_line = b"    image: " + PREVIOUS.encode()
assert old_compose.count(old_image_line) == 1
new_compose = old_compose.replace(old_image_line, b"    image: infinite-canvas:" + VERSION.encode(), 1)
changed = False
try:
    assert inactive_tasks() == job_hashes
    COMPOSE.write_bytes(new_compose)
    changed = True
    intended = json.loads(json.dumps(before_config))
    intended["services"]["app"]["image"] = "infinite-canvas:" + VERSION
    assert compose_config() == intended
    subprocess.run(["docker", "compose", "-f", str(COMPOSE), "up", "-d", "--no-build", "--no-deps", "app"], check=True)
    for attempt in range(30):
        try:
            assert fetch("/api/health").strip() == b"ok"
            assert fetch("/api/health", "http://127.0.0.1:3002").strip() == b"ok"
            break
        except Exception:
            if attempt == 29:
                raise
            time.sleep(2)

    app, worker = inspect("infinite-canvas"), inspect("infinite-canvas-video-worker")
    assert app["Config"]["Image"] == "infinite-canvas:" + VERSION
    assert mounts(app) == mounts(before_app) and environment(app) == environment(before_app)
    assert worker["Id"] == before_worker["Id"] and mounts(worker) == mounts(before_worker)
    assert worker["State"]["StartedAt"] == before_worker["State"]["StartedAt"]
    assert environment(worker) == environment(before_worker)
    assert run("docker", "exec", "infinite-canvas", "cat", "/app/VERSION") == VERSION
    backend = run("docker", "exec", "infinite-canvas", "sha256sum", "/app/server").split()[0]
    candidate = run("docker", "run", "--rm", "--entrypoint", "sha256sum", "infinite-canvas:" + VERSION, "/app/server").split()[0]
    previous = run("docker", "run", "--rm", "--entrypoint", "sha256sum", PREVIOUS, "/app/server").split()[0]
    assert backend == candidate == previous, "Frontend-only release changed or mismatched backend"

    html = fetch("/").decode()
    assets = sorted(set(re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)))
    main = next(asset for asset in assets if re.fullmatch(r"/assets/index-[^/]+\.js", asset))
    hashes = {}
    for asset in assets:
        digest = hashlib.sha256(fetch(asset)).hexdigest()
        assert digest == run("docker", "exec", "infinite-canvas", "sha256sum", "/app/web/dist" + asset).split()[0]
        hashes[asset] = digest
    bundle = fetch(main).decode()
    markers = [
        "根据成片反馈调整方案", "按成片反馈定位", "AI 对问题的理解", "不发送成片画面", "来源任务：",
        "通用任务对话工作台", "拍摄方案对话工作台", "改编脚本对话工作台", "画布任务对话",
        "当前对象", "修改范围", "来源依据", "版本/状态", "讨论需求", "确认方案", "预览候选",
        "开始讨论", "整理修改方案", "确认方案并生成候选", "采用候选", "放弃候选",
        "待确认修改方案", "候选修改标记", "当前正式内容", "待确认候选", "费用确认", "确认费用并继续",
        "起点、中点和终点共 3 帧", "这只表示方案里的引用未关联到当前可发送图片，不代表文件已删除。",
        "grid-cols-2 gap-2 text-xs", "[overflow-wrap:anywhere]", VERSION,
    ]
    assert all(marker in bundle for marker in markers), "Missing release preview interaction marker"
    assert "音频保存在当前浏览器的素材库" in bundle, "Existing v0.19.170 feature marker is missing"
    pages = ["/", "/admin/settings", "/admin/models", "/video", "/image", "/cases", "/cases/image-variations", "/video/content-replace", "/video/viral-recreate", "/video/voice-extract", "/video/store-explore", "/assets", "/prompts"]
    for page in pages:
        assert main.encode() in fetch(page), page
    settings = json.loads(fetch("/api/settings"))
    assert settings["code"] == 0

    live = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    current = sqlite3.connect(":memory:")
    live.backup(current)
    live.close()
    assert current.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    schema, counts, protected = db_snapshot(current)
    assert (schema, counts, protected) == (old_schema, old_counts, old_protected)
    assert inactive_tasks() == job_hashes and media_snapshot() == before_media
    report = {
        "version": VERSION, "source": source, "previousImage": PREVIOUS,
        "appImage": app["Config"]["Image"], "appImageId": app["Image"],
        "workerImage": worker["Config"]["Image"], "workerUnchanged": True,
        "workerStartedAt": worker["State"]["StartedAt"], "publicAsset": main,
        "publicAssetHashes": hashes, "publicPages": pages, "health": "ok", "localHealth": "ok",
        "prebuildBackup": str(prebuild), "backup": str(final_backup), "databaseQuickCheck": "ok",
        "databaseSchemaPreserved": True, "tableCountsPreserved": True,
        "settingsAndAccountsPreserved": True, "existingMediaPreserved": len(before_media),
        "backendBinary": backend, "backendMatchesReleaseImage": True, "backendUnchanged": True,
        "storeFeedbackMarkersVerified": markers[:5], "conversationMarkersVerified": markers[5:-1],
        "noActiveCloudOrWorkerTasks": True,
        "existingJobRecordsPreserved": len(job_hashes), "composeOnlyAppImageChanged": True,
        "environmentValuesPreserved": True, "mountsPreserved": True, "databaseDSNVerified": True,
        "rollback": "restore final backup Compose and recreate app only",
        "paidInferenceSubmitted": False, "productionChannelSettingsChanged": False,
        "productionBrowserInteraction": False,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
except Exception:
    if changed:
        print("Deployment verification failed; restoring prior Compose and app only.", flush=True)
        COMPOSE.write_bytes(old_compose)
        subprocess.run(["docker", "compose", "-f", str(COMPOSE), "up", "-d", "--no-build", "--no-deps", "app"], check=True)
    raise
