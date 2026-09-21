#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-}"
APP_DIR="/opt/infinite-canvas"
COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"
BACKUP_DIR="$APP_DIR/backups"
HEALTH_URL="https://studio.lingzhouai.com/api/health"
COMPOSE=(docker compose)

if [[ -z "$IMAGE" ]]; then
  echo "Usage: $0 <image>" >&2
  echo "Example: $0 ghcr.io/thinkinwalk/infinite-canvas:v0.19.11" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
COMPOSE_BACKUP="$BACKUP_DIR/docker-compose.deploy.yml.$TS.bak"
DATA_BACKUP="$BACKUP_DIR/data-before-deploy-$TS.tgz"
cp "$COMPOSE_FILE" "$COMPOSE_BACKUP"
tar -C "$APP_DIR" -czf "$DATA_BACKUP" data .env docker-compose.deploy.yml

python3 - "$COMPOSE_FILE" "$IMAGE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
image = sys.argv[2]
text = p.read_text()
lines = text.splitlines()
changed = False
out = []
for line in lines:
    if line.strip().startswith('image:') and not changed:
        indent = line[: len(line) - len(line.lstrip())]
        out.append(f'{indent}image: {image}')
        changed = True
    else:
        out.append(line)
if not changed:
    raise SystemExit('image line not found in compose file')
p.write_text('\n'.join(out) + '\n')
PY

cd "$APP_DIR"
docker pull "$IMAGE"
"${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d app

ok=0
for i in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "$ok" != "1" ]]; then
  echo "Health check failed; rolling back compose file." >&2
  cp "$COMPOSE_BACKUP" "$COMPOSE_FILE"
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d app
  exit 1
fi

echo "Deployed $IMAGE"
echo "Compose backup: $COMPOSE_BACKUP"
echo "Data backup: $DATA_BACKUP"
