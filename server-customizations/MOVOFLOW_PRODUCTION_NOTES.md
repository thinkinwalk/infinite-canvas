# Lingzhou Studio Infinite Canvas production notes

This file is the current production handoff for the Infinite Canvas deployment. It supersedes the old MovoFlow runtime notes.

## Current runtime

- Domain: https://studio.lingzhouai.com
- Runtime host: 37.221.196.102
- SSH user: root
- SSH port: 22
- Hostname: v2202606374943476754
- SSH key path on this workstation: C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519
- Recommended SSH command: ssh -o BatchMode=yes -o IdentitiesOnly=yes -i C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519 root@37.221.196.102
- App directory: /opt/infinite-canvas
- Compose file: /opt/infinite-canvas/docker-compose.deploy.yml
- Container name: infinite-canvas
- Data directory: /opt/infinite-canvas/data
- Current production image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.6

Do not commit private key material. The key path above is recorded only so future local Codex sessions can connect through the existing workstation key.

## Important migration notes

- The project directory is /opt/infinite-canvas. Do not use /opt/chatgpt2api for this project.
- The old production host 47.104.6.6 has been migrated away. Do not deploy there for the current Lingzhou Studio production site.
- The old domain https://studio.movoflow.com is no longer the production validation target.
- The new server has Docker Compose v2. Use docker compose, not docker-compose.

## Deployment helper

Deployment helper on production:

```bash
/opt/infinite-canvas/deploy_infinite_canvas_image.sh
```

Local copy in this repo:

```bash
server-customizations/deploy_infinite_canvas_image.sh
```

Example production deploy command:

```bash
/opt/infinite-canvas/deploy_infinite_canvas_image.sh ghcr.io/thinkinwalk/infinite-canvas:v0.19.6
```

The helper backs up data and docker-compose.deploy.yml, pulls the image, restarts only the app service, checks /api/health, and restores the previous compose file if the health check fails.

## Safe future deployment process

Do not build images on the production host.

1. Build and publish the image from CI or another build machine.
2. Confirm the image tag exists, for example ghcr.io/thinkinwalk/infinite-canvas:v0.19.4.
3. SSH to production:

```bash
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519 root@37.221.196.102
```

4. Deploy the image:

```bash
cd /opt/infinite-canvas
./deploy_infinite_canvas_image.sh ghcr.io/thinkinwalk/infinite-canvas:<version>
```

5. Verify externally:

```bash
curl -fsS https://studio.lingzhouai.com/api/health
curl -I https://studio.lingzhouai.com/
```

6. Verify on the host when needed:

```bash
docker inspect infinite-canvas --format '{{.Config.Image}}'
docker exec infinite-canvas cat /app/VERSION
curl -fsS http://127.0.0.1:3002/api/health
```

## Current Seedance model fix state

- Release tag deployed for the current production fixes: v0.19.6
- Relevant image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.6
- Expected settings response includes seedance-2.0-mini and tejiasd-mini-720p in availableModels when enabled in channels.
- Expected platform settings have allowCustomChannel=false so frontend should prefer platform models when no usable local channel is configured.
- seedance-2.0-mini is configured on the Lingzhou relay channel with Base URL https://api.lingzhouai.com and protocol openai. It must use JSON POST /v1/videos, not Fireworks/Ark Agent Plan POST /v1/contents/generations/tasks.
- Fireworks/Ark Agent Plan Seedance routing is selected only when the channel Base URL includes /api/plan/v3.

## Known good verification from latest deployment

- DNS: studio.lingzhouai.com resolves to 37.221.196.102.
- External health check: https://studio.lingzhouai.com/api/health returns ok.
- Production container image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.6.
- Production container /app/VERSION: v0.19.6.

## Recent backups on production

- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260915-121127.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260915-121127.tgz
- /opt/infinite-canvas/deploy_infinite_canvas_image.sh.bak-20260915-121811
