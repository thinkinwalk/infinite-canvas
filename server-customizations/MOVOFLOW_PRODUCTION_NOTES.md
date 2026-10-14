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
- Current production image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.45

Do not commit private key material. The key path above is recorded only so future local Codex sessions can connect through the existing workstation key.

## Worker task identity hotfix after v0.19.45

- Commit `b43b75d` fixes a media-validation loop overwriting the worker task UUID with the final media filename. New worker jobs with video inputs failed with HTTP 400 / “任务标识不正确” before processing, including replacement planning. Main app remains v0.19.45.
- Production worker mounts `/opt/infinite-canvas/releases/worker-job-identity-app.py` read-only at `/worker/app.py` in Compose. SHA256: `48a8c9fc8cb1276b4752d7aaec6fa0a1cbfca4f6ba3a6d1f097b2985edc7f833`. Preserve this mount on future deployments. It differs from the v0.19.43 source by the two-line variable rename only.
- No worker job was running before replacement. Backups of Compose, previous source and all 10 worker job records are in `/opt/infinite-canvas/backups/worker-job-identity-20261014-014704/`. Existing job records remained identical after restart; only the worker service was updated.
- Five local regression tests passed, including HTTP create/read/reuse/conflict checks for supplied/generated UUIDs and single/list media inputs. A production request using the original paused job's worker UUID and video completed replacement-plan successfully (15 seconds, 720×1280, 10 detected segments); repeated submission reused the same job. No paid model call was made. The parent replacement task remains paused with zero credits until the user clicks 恢复处理 for quotation, then separately confirms generation.
- Evidence and deployment scripts: `artifacts/worker-job-identity/` beside the repository. Main/worker health passed after deployment.

## v0.19.45 subtitle opt-in deployment

- Release revision `98a64f9949253dc18ea613a8d5aec954cd264d5e`, digest `sha256:80d1fc11e41c1c5ceb0a71eb7baeba2a864355b0dc58c6b5447b3ba61d03c202`. Application workflow https://github.com/thinkinwalk/infinite-canvas/actions/runs/38495787560 succeeded; docs and plugins also succeeded. The intermediate v0.19.44 tag was not deployed.
- New drafts disable subtitle cleanup by default. An unavailable subtitle processor disables an existing draft's option automatically while preserving its inputs and output. Manual enabling remains selected in the current page and blocks analysis when unavailable. Cleanup still requires LaMa or an equivalent configured service; this release does not deploy that engine.
- Three replacement API tests passed; Vite production build passed with existing bundle warnings. Typecheck reported four existing baseline errors in use-video-workbench.ts, viral-recreate-workspace.tsx, use-config-store.ts and use-home-draft-store.ts. Isolated local browser checks with mocked APIs verified preserved draft media/instructions/output, manual enabling, disabled analysis and re-enabling analysis after switching cleanup off.
- Real production page https://studio.lingzhouai.com/video/content-replace returned 200 with `/assets/index-CY5qGb4g.js`, cleanup off by default and no page errors in independent Chrome. This check was unauthenticated; authenticated quotation and paid model generation were not performed. Internal/external health and SQLite quick_check passed. Worker start time remained `2026-10-14T00:16:02.490083702Z`; it was not restarted.
- Worker capabilities confirm OCR, planning, extraction, validation, assembly and finish are available; replacement-prepare remains unavailable. Worker v0.19.43 was already deployed before this frontend patch; the older v0.19.42 source mount below is historical.
- Backups: `/opt/infinite-canvas/backups/database-before-v0.19.45.sqlite`, `/opt/infinite-canvas/backups/data-before-deploy-20261014-033205.tgz`, `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261014-033205.bak`. Evidence: `artifacts/release-v0.19.45/` beside the repository.

## v0.19.42 reference video trimming deployment

- Release revision `4afefa5064b4275a7745aa6a9749d8f5feb2fa23`, image digest `sha256:7c18a2c9ee6e5acf954b3fa58b0d736c1a30a34132d84012b339bd5dc8610f67`; app/docs/plugin workflows succeeded. App workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38413838189.
- Worker now advertises `trim`, validates 1–15-second ranges and source bounds, and returns H.264 MP4 with the source audio when present. No worker job was running during replacement; all six existing worker job files remained identical. Source is mounted read-only from `/opt/infinite-canvas/releases/v0.19.42/video-worker-app.py` to `/worker/app.py` in production Compose; preserve or explicitly update this mount on future worker releases. SHA256: `abb98d353207d35b13eb8ad6c43a505204b2f8b9f16037dd27f8afc28d39ff36`. Worker source and Compose rollback backup: `/opt/infinite-canvas/backups/worker-before-v0.19.42-20261013-163041/`. No production image build was performed.
- Independent production Chrome verified a 20-second input warning and disabled submission, one-click output exactly15 seconds, manual3–9-second output exactly6 seconds, enabled content-replace submission after reference image upload, and restored6-second draft after reload. Worker rejected16-second, negative-start and subsecond ranges with422. No paid upstream generation was submitted and no page runtime error occurred. Local ordinary video page and failed-service preservation also passed. Evidence: `artifacts/reference-trim/` and `artifacts/release-v0.19.42/` beside the repository.
- Internal/external health returned `ok`; SQLite quick_check passed, settings and14 video /8 Replicate tasks matched the deployment backup. App backups: `/opt/infinite-canvas/backups/database-before-v0.19.42-20261013-163443.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.42-20261013-163443.tgz`, `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-163443.bak`. App rollback preserves the updated worker; worker rollback uses its separate Compose backup above.

## v0.19.41 Wan30 duration correction verification

- Deployed release `v0.19.41`, revision `be3e2828e77454dd937cdff6fcec3757ce12688f`, digest `sha256:767b0e093301415029d428e1213f8e13d06800d7311c719da7f0a220fd42a26f`. App workflow https://github.com/thinkinwalk/infinite-canvas/actions/runs/38409799379 succeeded, as did docs and plugins.
- Corrects v0.19.40's mistaken fixed 30-second setting. Production capabilities and slider now use the site's existing 4–30-second range; 30 is the maximum. Independent Chrome verified 6/16/30-second selection and 16 seconds retained after reload. Authenticated quotes are 252/672/1260 credits respectively. No paid generation was submitted and no page runtime errors occurred.
- Internal/external health returned `ok`; SQLite quick_check passed, settings and 12 video / 8 Replicate tasks matched the backup, worker start time remained unchanged. Backups: `/opt/infinite-canvas/backups/database-before-v0.19.41-20261013-160608.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.41-20261013-160608.tgz`, `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-160608.bak`. Evidence: `artifacts/release-v0.19.41/` beside the repository.

## v0.19.40 Wan30 capability deployment verification (historical; duration corrected above)

- Release commit: `22fa52d17a4fb356f79835d810440fff6eeb69b2`; release tag: `v0.19.40`. App image workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38407074653. Application, documentation and official plugin workflows succeeded; GitHub Pages skipped by configuration.
- Image digest: `sha256:479666ada1c52a61e2b452f17ccf3dabb34f5575f4afcb4402d551e54a38fdd8`. Container version and revision match the release; internal and external health checks return `ok`.
- Channel 14 / `lingzhouai-sp` retains VIP access and now exposes `wan30-720p` relay/reference capabilities: 10 images, 5 videos, 5 audios, 720p, 30 seconds. User-approved price is 42 credits/second; production quote is1260 credits/30 seconds at the existing VIP ratio1.
- Independent Chrome verified the ordinary video entry, capability refresh on an opened page's focus event, content-replace button enabled after local test uploads, and720p/30-second parameter choices without runtime errors. No paid task was created; actual upstream field acceptance and output quality remain unverified.
- Backups: `/opt/infinite-canvas/backups/database-before-v0.19.40-20261013-154613.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.40-20261013-154613.tgz`, `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-154613.bak`. SQLite quick_check is `ok`; settings,12 video tasks and8 Replicate tasks match the pre-deploy backup. Worker start time remains `2026-10-09T06:50:12.435805303Z`. Previous image remains available for rollback. Evidence: `artifacts/release-v0.19.40/` beside the repository.

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
/opt/infinite-canvas/deploy_infinite_canvas_image.sh ghcr.io/thinkinwalk/infinite-canvas:v0.19.23
```

The helper backs up data and docker-compose.deploy.yml, pulls the image, restarts only the app service, checks /api/health, and restores the previous compose file if the health check fails.

## Safe future deployment process

Do not build images on the production host.

1. Build and publish the image from CI or another build machine.
2. Confirm the image tag exists, for example ghcr.io/thinkinwalk/infinite-canvas:v0.19.19.
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

## v0.19.39 内容替换人物建议提示收纳

- Release commit: `232246c0fceb84df8913b82167953fe9f2d6aad9`; tag: `v0.19.39`; image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.39`; digest: `sha256:56eea1620c3c0850a0d2818897f6d56f798f62c77d449d8e0e48bd3fac223474`. App, docs and official plugin workflows succeeded; GitHub Pages skipped as configured. App workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38383566077.
- Production image revision and `/app/VERSION` match v0.19.39. Internal/external health return `ok`; `/`, `/video/content-replace`, `/video`, `/image` and `/digital-human` return HTTP 200. The served content-replacement JavaScript contains the compact「素材建议」entry and the full click/tap guidance. The first post-restart readiness probe returned 502; the deployment retry succeeded and subsequent health and route checks passed.
- Consistent backups: `/opt/infinite-canvas/backups/database-before-v0.19.39-20261013-123431.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.39-20261013-123431.tgz` and `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-123431.bak`. Database `quick_check` is `ok`; settings and all eight historical tasks match the deployment backup. Existing worker start time remains `2026-10-09T06:50:12.435805303Z`. Previous v0.19.38 image remains available for rollback. No paid prediction was submitted. Evidence is beside the repository in `artifacts/release-v0.19.39/`.

## v0.19.38 内容替换人物空掩膜失败提示

- Release commit: `356170eef9fba8178dd7b8c76b22c00be6a9f12c`; tag: `v0.19.38`; image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.38`; digest: `sha256:c211fcc7de5e08bb1cc3adc22583f9ee447ce3041ee0136e3be81452fcda2aed`. App, docs and official plugin workflows succeeded; GitHub Pages skipped as configured. App workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38379784003.
- Production image revision and `/app/VERSION` match v0.19.38. Internal/external health return `ok`; `/`, `/video/content-replace`, `/video`, `/image` and `/digital-human` return HTTP 200. The served content-replacement JavaScript includes the person-tracking guidance, duration/charge and server refund status copy.
- Consistent backups: `/opt/infinite-canvas/backups/database-before-v0.19.38-20261013-120052.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.38-20261013-120052.tgz` and `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-120052.bak`. Database `quick_check` is `ok`; settings and all seven historical tasks match the backup. Existing worker start time remains `2026-10-09T06:50:12.435805303Z`; compose capability remains available. Previous v0.19.37 image remains available for rollback. No paid prediction was submitted; the failed incident task had already been refunded 1120 credits by the service. Evidence is beside the repository in `artifacts/release-v0.19.38/`.

## v0.19.37 内容替换上传交互优化

- Release commit: `56143eff2d897e64c65fed664436736409b11852`; image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.37`; digest: `sha256:3d2a9a5e47e7e18618f17bce6674667629c18ee3d3a5508538181df9a12b3b2f`. App, docs and plugin workflows succeeded; the docs ARM dependency extraction failure passed on rerun. GitHub Pages skipped as configured. Release: https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.37; app workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38370377665.
- Production image, OCI revision and `/app/VERSION` match the release. Internal/external health and common page routes return HTTP 200. Public `/assets/index-DZGTh2Yu.js` contains the new uploaded-material actions and removes the duplicate replacement dropzone. Independent production browser verified video/image upload cards, image replacement, persistence after reload, removal restoring the empty upload state and playable video; no page runtime errors or paid predictions. User browser drafts were preserved.
- Consistent backups: `/opt/infinite-canvas/backups/database-before-v0.19.37-20261013-104044.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.37-20261013-104044.tgz` and `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-104044.bak`. Database `quick_check` is `ok`; settings and all 7 historical tasks match the deployment backup. Existing worker start time remains `2026-10-09T06:50:12.435805303Z`; its compose/transcode capability is available. Previous v0.19.36 image remains available for rollback. Evidence is beside the repository in `artifacts/release-v0.19.37/`.

## v0.19.36 内容替换视频预览修复

- Release commit: `60b6d86afcf1439a7e14423f3928119366359e49`; image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.36`; digest: `sha256:6481893869cd765cbd00ce1cf6026428a5d576fbf6e862e5343f104724809354`. App, docs and plugin workflows succeeded; GitHub Pages skipped as configured. Release: https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.36; app workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38366448417.
- Production image, OCI revision and `/app/VERSION` match the release. Internal/external health and normal page routes return HTTP 200; the public `/assets/index-Cid7r3DK.js` contains the release and source-preview repair action. Existing worker start time remains `2026-10-09T06:50:12.435805303Z` and its compose/transcode capability is available. Database `quick_check` is `ok`; settings and all 5 historical tasks match the deployment backup.
- Consistent backups: `/opt/infinite-canvas/backups/database-before-v0.19.36-20261013-100553.sqlite`, `/opt/infinite-canvas/backups/data-before-v0.19.36-20261013-100553.tgz` and `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261013-100553.bak`. Previous v0.19.35 image remains available for rollback.
- Local Firefox playback and failure protection passed 7 checks with a real isolated FFmpeg worker. Production release verification did not create paid predictions or alter the user's browser cache; the original uploaded video still requires refresh and the repair action in the original browser. Evidence is beside the repository in `artifacts/content-replace-playback/` and `artifacts/release-v0.19.36/`.

## v0.19.30 首尾帧画幅与构图优化

- Release commit: `0a67c8664d3633d2787093b1c350c665e7b0f7e3`; image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.30`; digest: `sha256:6884cd3a7b9d9980e6bd5724abcfe51df6100379bc2cbc6c6453bd2f82134eda`. App, docs and plugin workflows succeeded; GitHub Pages skipped as configured. App workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38216347736.
- Production image, OCI revision and `/app/VERSION` match the release. Internal/external health returns `ok`; `/video` returns HTTP 200 and loads `/assets/index-CTRN-qHn.js`. Independent in-app browser verification confirms Wan first/last-frame settings expose 16:9 and 9:16, with the summary updating when portrait is selected. No paid generation was submitted. Existing video worker start time remains unchanged.
- SQLite online backup passed `PRAGMA quick_check`: `/opt/infinite-canvas/backups/database-before-v0.19.30-20261012-091644.sqlite`; consistent archive: `/opt/infinite-canvas/backups/data-before-v0.19.30-20261012-091644.tgz`; compose backup: `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261012-091644.bak`. Previous v0.19.29 image remains available for rollback.
- Deployment output and production settings screenshot are beside the repository in `artifacts/release-v0.19.30/`. Real sample quality, final output dimensions and credit settlement remain business acceptance items.

## v0.19.29 视频创作台交互优化

- Release commit: `f1e8cfa90fa62787cde359f066fa8d65d8e3cff9`; image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.29`; digest: `sha256:2d7d743a949acb2b29748d80d2235806fa495b497d3ddcd41e7cc57ba4f3627f`. App, docs and plugin workflows succeeded; GitHub Pages skipped as configured. App workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38212561666.
- Production image, OCI revision and `/app/VERSION` match the release. Internal/external health and `/`, `/video`, `/image`, `/digital-human` return HTTP 200. The existing video worker remains running with its original start time.
- SQLite online backup passed `PRAGMA quick_check`: `/opt/infinite-canvas/backups/database-before-v0.19.29-20261012-083110.sqlite`; consistent archive: `/opt/infinite-canvas/backups/data-before-v0.19.29-20261012-083110.tgz`; compose backup: `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261012-083110.bak`. Previous v0.19.28 image remains available for rollback.
- Independent Chrome production verification passed with the real model directory: quick settings popover, resolution buttons, removal of the old modal and current frontend after reload. No page runtime errors or generation requests. Evidence is beside the repository in `artifacts/release-v0.19.29/`; real generation results and credit settlement remain business acceptance items.

## v0.19.28 本地视频缓存恢复

- Firefox 实际播放 IndexedDB 旧 MPEG-4 副本；上次服务器 H.264 转码没有更新浏览器本地作品。
- 视频创作台新增「重新获取视频」，只下载原 Replicate 任务结果。浏览器成功解码首帧后替换原媒体存储键并更新预览/作品记录；错误响应或解码失败保留旧文件。不创建预测、不扣费。
- 用户原 Firefox 未开启调试端口，未改写其浏览器数据库；需刷新页面加载新版后，在「我的作品」打开旧作品并点击「重新获取视频」。

- Production app release commit: `d95e7019bf33008ad5765e6c387799c7485f7b22`; image digest: `sha256:4704cc0baf2d0a30084b70f39dd4244ba8d885506de6ecbe61b30f147f301069`. App and docs image workflows passed; production image, VERSION and health checks match v0.19.28. The existing video worker was preserved.
- SQLite online backup passed `PRAGMA quick_check`: `/opt/infinite-canvas/backups/database-before-v0.19.28-20261011-124056.sqlite`; consistent archive: `/opt/infinite-canvas/backups/data-before-v0.19.28-20261011-124056.tgz`; compose backup: `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261011-124056.bak`.
- Independent Firefox 157.0.1 production validation passed: original Blob failed decoding; existing task content GET returned 2,945,420 bytes; recovery replaced the same local media key, decoded 720×1280/5.063s, advanced playback and persisted across refresh. Non-video HTTP200, undecodable MP4 and HTTP401 kept the original Blob. One content request and zero prediction submissions during recovery. Evidence is beside the repository in `artifacts/release-v0.19.28/`.

## v0.19.27 视频播放兼容性修复

- Wan 文生视频返回的 MP4 实际为 MPEG-4 Part 2 Simple Profile，Chrome/Edge 无法播放；已将当前结果转为 H.264/YUV420P，并在结果保存阶段对后续非 H.264 视频自动转码。
- 转码使用应用镜像内已有 FFmpeg，输出保留 MP4、快速开始标记及音频转 AAC；本次未重新创建付费任务。

## v0.19.26 Wan 文生视频版本修复

- Wan 文生视频原固定版本 `9f0a607c444c14a25ca46cb94f01d83566e40a7c68ee0d313cb8b8b5e5cf2c09` 已被 Replicate 删除，生产提交阶段因此返回 422 且没有 prediction ID。
- 新版本 `c483b1f7b892065bc58ebadb6381abf557f6b1f517d2ff0febb3fb635cf49b4d` 已通过生产令牌的只读版本接口读取，官方输入 schema 与现有 T2V 请求兼容；本次没有创建付费预测。
- `callReplicate` 现在会在不记录密钥的前提下保留上游 4xx 的安全截断原因，便于后续区分版本、参数、权限和余额问题。

## v0.19.25 视频自动匹配与 H3 修复部署验证

- Release commit: `246c67de6791380a53e514bccc7a6b22110a16ad`; release tag: `v0.19.25`; GitHub Release: https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.25.
- App image workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38110545421. Published image digest: `sha256:2b0cecc393980f422af75876c45cfe4dc5f8d30c7ea0b29ac352926d2112e8af`. Docs image and official plugin publishing workflows also succeeded; GitHub Pages skipped as configured.
- Production container image, `/app/VERSION`, and OCI image revision match this release. Internal and external health return `ok`; `/`, `/video`, `/image`, and `/digital-human` return HTTP 200. The existing video worker remained running.
- SQLite online backup passed `PRAGMA quick_check`: `/opt/infinite-canvas/backups/database-before-v0.19.25-20261011-040730.sqlite`. Deployment helper additionally preserved `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261011-061130.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261011-061130.tgz`; these backup files are root-only. The previous app image `v0.19.24-h3-fix4` remains available for rollback.
- Using the logged-in session from BitBrowser 464 in an independent temporary browser context, verified the normal `/video` entry chooses T2V, one image switches to I2V, two images use first/last frames, removing images restores T2V, and reload retains the new directory. Real quote responses for 720p / about 5 seconds returned 390 credits for both T2V and base I2V under the verification account. No page runtime errors and no paid predictions were created; original user tabs were preserved.
- Evidence is stored beside the repository in `artifacts/release-v0.19.25/`. Real video quality, specification compliance, and charge/refund behavior still require business-material acceptance.

## v0.19.24 运维兑换码内部 Token 部署验证

- Release commit: `f6a908d`; release tag: `v0.19.24`.
- GitHub Actions Docker image workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38051658665. Published image digest: `sha256:a65ac8379f91129a5557f68ba98e305427493fc34252e0b92b88132062852bcd`.
- Production container image and `/app/VERSION` both report `v0.19.24`; internal `/api/health` returns `ok` and external `https://studio.lingzhouai.com/api/health` returns HTTP 200.
- Deployment helper created `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261010-142904.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261010-142904.tgz`. Token configuration additionally preserved `/opt/infinite-canvas/backups/.env.before-redemption.bak` and `/opt/infinite-canvas/backups/docker-compose.deploy.yml.before-redemption.bak`.
- A shared random internal Token is loaded into the canvas container and the production `lingzhou-price-sync.service` through root-only environment files; the Token value is intentionally not recorded here.
- Read-only `GET /api/admin/redemption-codes?page=1&pageSize=1` with `X-Internal-Redemption-Token` returned HTTP 200 and business code `0`. No redemption code was created, disabled, or listed in the verification output.

## v0.19.23 homepage creation entry deployment verification

- Release commit: `5e28e3ceeb56b8f949739f9d0bf41394c2766172`; release tag: `v0.19.23`.
- GitHub Actions Docker image workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38022222081. Published image digest: `sha256:25326e0d8dee39e3fc4596a290a3f8edef37817963f3b22807850ad50671515e`.
- Production deployment helper completed successfully on 2026-10-10. It created `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261010-060028.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261010-060028.tgz`; the first health probe returned 502 during container startup and the helper passed on its retry loop without rollback.
- Production container image and `/app/VERSION` both report `v0.19.23`; internal and external `/api/health` return `ok`. External `HEAD` checks for `/`, `/image`, `/video` and `/digital-human` return HTTP 200.
- This release adds homepage image/video/digital-human creation entry switching, separate local drafts and workbench transfer; no paid generation was submitted during release verification.

- Release tag deployed for the current production fixes: v0.19.22
- Relevant image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.22
- Expected settings response includes seedance-2.0-mini and tejiasd-mini-720p in availableModels when enabled in channels.
- Expected platform settings have allowCustomChannel=false so frontend should prefer platform models when no usable local channel is configured.
- seedance-2.0-mini is configured on the Lingzhou relay channel with Base URL https://api.lingzhouai.com and protocol openai. It must use JSON POST /v1/videos, not Fireworks/Ark Agent Plan POST /v1/contents/generations/tasks.
- Fireworks/Ark Agent Plan Seedance routing is selected only when the channel Base URL includes /api/plan/v3.

## Known good verification from latest deployment

- DNS: studio.lingzhouai.com resolves to 37.221.196.102.
- External health check: https://studio.lingzhouai.com/api/health returns ok.
- Production container image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.25.
- Production container /app/VERSION: v0.19.25.

## v0.19.21 / v0.19.22 text editor deployment verification

- Final release commit: `af0f8da1b9499ed78369e2852d1069b83256e6c9`; image `ghcr.io/thinkinwalk/infinite-canvas:v0.19.22`; digest `sha256:f9b603e095ad36e2237a2f3b388bb90b5dd242c7e07e957ae01a7d6b7817ce1b`. Container version and image revision match. App, docs and plugin workflows succeeded; app workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/37935872406.
- Internal/external health returns `ok`. The production viral-recreate page renders the new text editor without console errors. v0.19.21 browser acceptance verified a 752-character sample, sidebar sync, refresh recovery and fullscreen; final v0.19.22 recheck verified the editor entry and clean console. Local mobile width 390px opens the editor fullscreen without horizontal overflow.
- v0.19.22 explicitly preserves pending AI script suggestions while editing the current draft. No paid generation was submitted; real AI suggestion acceptance and material references remain user acceptance items.
- SQLite backup passed quick_check: `/opt/infinite-canvas/backups/database-before-v0.19.22-20261009-151953.sqlite`. Deploy backups: `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261009-152245.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261009-152245.tgz`. Video worker stayed running.
- Screenshots from the independent browser test, using clearly labeled sample copy, are stored beside the checkout in `artifacts/release-v0.19.21/`. Sample text was cleared after verification. Vite production build succeeded; complete TypeScript checking still reports the pre-existing admin task reconciliation call missing its predictionId argument.

## v0.19.19 deployment verification

- Release commit: `00a1fb25079cedd7fb297355363be1b18bbc272d`; tag `v0.19.19` and the GitHub Release are published in `thinkinwalk/infinite-canvas`.
- App image, docs image and official plugin workflows succeeded; GitHub Pages skipped as configured. App workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/37895987747.
- Production image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.19`; image digest: `sha256:2ac3217eb578843c71838967e335292ec7cecbedcd5fada6a2bd4d0bb107fa02`.
- Container `/app/VERSION` and image revision match the release; the running binary contains the image channel failover logic. Internal and external health checks return `ok`; `/`, `/image`, `/digital-human` and `/video` return HTTP 200.
- SQLite online backup passed `PRAGMA quick_check`: `/opt/infinite-canvas/backups/database-before-v0.19.19-20261009-065456.sqlite`. Deployment helper also created `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261009-085911.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261009-085911.tgz`.
- Deployment evidence is saved beside the checkout in `artifacts/release-v0.19.19/`. No paid generation was submitted; real upstream failover, credit settlement and browser retry remain for manual acceptance. Local development backend was not restarted.

## v0.19.20 deployment verification

- Release commit: `9f43c6ad807f9ccc1af0710a752351f29a2a54bb`; tag `v0.19.20` is published. App, docs and official plugin workflows succeeded; app workflow: https://github.com/thinkinwalk/infinite-canvas/actions/runs/37916567505.
- Production image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.20`; image digest: `sha256:7104f25b17ebd576ff5233486b4e572ca3c241409ca93ac254a958e2f3a63e5f`. Container version and image revision match the release; internal and external health checks return `ok`, and the viral-recreate page returns HTTP 200 and renders without browser console errors.
- Reference analysis, product analysis and script writing now validate/quote the text model. Final video generation still validates/quotes the video model. The independent browser page was not logged in, so no paid analysis or generation was submitted; authenticated click acceptance remains pending.
- SQLite online backup passed `PRAGMA quick_check`: `/opt/infinite-canvas/backups/database-before-v0.19.20-20261009-121821.sqlite`. Deployment helper saved `docker-compose.deploy.yml.20261009-122228.bak` and `data-before-deploy-20261009-122228.tgz` in the same backups directory.
- The existing `infinite-canvas-video-worker` container remained running. App setting `VIDEO_WORKER_URL=http://video-worker:8767` is retained; authenticated internal health confirms frames, compose, cut and transcribe available. Whisper small weights are mounted from `/opt/infinite-canvas/video-worker-models/whisper-small`.

## v0.19.18 deployment verification

- Release commit: 400b7ee19e2b0252859459cbf987335e7d6efbac; tag `v0.19.18` was pushed to the `thinkinwalk/infinite-canvas` repository.
- GitHub Actions Docker image workflow succeeded and published `ghcr.io/thinkinwalk/infinite-canvas:v0.19.18`; pulled image digest: `sha256:b27159df1a2974d93cd655ba454f67a537425ca04fa1ef7c000636ee89498cad`.
- Production deployment helper completed successfully and created `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261009-075319.bak` plus `/opt/infinite-canvas/backups/data-before-deploy-20261009-075319.tgz`.
- Container reports image `v0.19.18`, `/app/VERSION` is `v0.19.18`, and the container health endpoint returns `ok`.
- External `https://studio.lingzhouai.com/api/health` returns HTTP 200 with `ok`; `/`, `/digital-human`, `/video`, `/photo-talk`, and `/lipsync` return HTTP 200.

## v0.19.17 deployment verification

- Release commit: f0febbe4a66b767a3556feb18187846927c902ce.
- Image digest: sha256:6e7f3e2e7ae6029ec69dbf048c78c9fd0c2b4986a06f0dd9134a9e596badad70.
- App and docs image workflows succeeded; official plugins published; GitHub Pages skipped as configured.
- Public health and all three digital-human/video entry pages returned HTTP 200. Independent browser checks confirmed rendering and no horizontal overflow or page exceptions on desktop/mobile.
- Container version is v0.19.17; FFmpeg and FFprobe are installed; the ASR model is present in the running binary and result_json exists in the task table.
- Existing Replicate credential is preserved. ASR pricing remains unset/disabled; no paid transcription was submitted. Runtime bootstrap admin credentials did not authenticate, so the authenticated catalog check remains pending; account credentials were not changed.
- The independent video worker was not deployed; local development backend was not restarted.

## Recent backups on production

- /opt/infinite-canvas/backups/database-before-v0.19.19-20261009-065456.sqlite (SQLite online backup).
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20261009-085911.bak
- /opt/infinite-canvas/backups/data-before-deploy-20261009-085911.tgz

- /opt/infinite-canvas/backups/database-before-v0.19.17-20261008-142105.sqlite (SQLite online backup).
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20261008-142105.bak
- /opt/infinite-canvas/backups/data-before-deploy-20261008-142105.tgz

- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260930-111347.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260930-111347.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260930-101458.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260930-101458.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260930-091104.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260930-091104.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260921-060906.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260921-060906.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260921-055610.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260921-055610.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260921-053418.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260921-053418.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260921-051249.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260921-051249.tgz
- /opt/infinite-canvas/backups/docker-compose.deploy.yml.20260915-121127.bak
- /opt/infinite-canvas/backups/data-before-deploy-20260915-121127.tgz
- /opt/infinite-canvas/deploy_infinite_canvas_image.sh.bak-20260915-121811

## v0.19.31 H3video-2k deployment verification

- Release commit: `d2cbbf4dded762e06ef5beefa8acd4720db74a67`; tag/release: `v0.19.31`. App Docker workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38230594012; docs and official plugin workflows succeeded.
- Production image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.31`; digest: `sha256:d16e5c1af4134c20d3809e69f524f3d3b859af08afa32b67d4d1d657abb1df07`. Container image revision and `/app/VERSION` match the release; internal/external health returns `ok`, `/video` HTTP 200. Served asset `/assets/index-g8ifPV_p.js` contains the release version, H3 adapter and fixed15-second UI.
- Before deployment, SQLite online backup passed quick_check: `/opt/infinite-canvas/backups/database-before-v0.19.31-20261012-113954.sqlite`. Compose and data backups: `docker-compose.deploy.yml.20261012-113954.bak` and `data-before-v0.19.31-20261012-113954.tgz` in the same directory. The existing video worker remained running.
- H3 profile on its existing enabled channel now uses relay JSON, 2K/768p, 15 seconds, reference limits9 images/3 videos/3 audios. Production model cost is480 credits/request as explicitly confirmed; existing user-group multipliers still apply. No unrelated model price or channel access setting changed.
- Go video/H3 tests and9 frontend adapter/material tests pass; Vite build succeeds. Independent browser verified the built local page, stale-profile correction and switching from another model to2K/16:9/15 seconds,768p and portrait options. Production video page renders the published build. Existing bootstrap credentials did not authenticate, so authenticated production quote and paid generation were not tested; actual pixels, duration and media-reference output remain pending. No credentials changed. Existing wider Wan test and unrelated TypeScript failures are recorded in pending-test.
- Evidence and helpers are saved beside the checkout in `artifacts/release-v0.19.31/`.

## v0.19.32 H3 duration correction deployment verification

- Release commit: `7357b3273cc2107a042eb785cf088e06d57bff5d`; tag/release: `v0.19.32`. App workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38267167769; docs and plugin workflows also succeeded.
- Current image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.32`; digest: `sha256:f190332f2335d15ab97f656fe8ee6917c8889d8299202e2e14bf0328c40d780e`. Container revision and VERSION match; internal/external health return HTTP200 `ok`.
- H3 duration choices are5/10/15 seconds, default15, based on the user's latest upstream confirmation. Both frontend profiles and backend quote/submission checks accept the three choices. Production channel profile has seconds `["15","5","10"]`; price remains480 credits/request, and no unrelated price changed.
- Consistent SQLite/data/Compose backups created in `/opt/infinite-canvas/backups/`: `database-before-v0.19.32-20261012-170643.sqlite`, `data-before-v0.19.32-20261012-170643.tgz`, and `docker-compose.deploy.yml.20261012-170643.bak`. Initial startup probe returned502; deployment retry succeeded. Video worker remained running.
- Go H3 tests cover both resolutions and all three durations;11 frontend adapter/material tests pass. CI built the production image successfully. No paid generation or authenticated production quote submitted; actual upstream output remains pending. Helpers/evidence are beside the checkout in `artifacts/release-v0.19.32/`.

## v0.19.34 Replicate channel management deployment verification

- Release commit: `b23f888fd15a2e224395805a7248370a58f547ae`; tag/release: `v0.19.34`. Docker workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38343839563. The v0.19.33 image was superseded before deployment by the legacy-task safety fix in v0.19.34.
- Production image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.34`; digest: `sha256:b0bee7561dbf6096846d000f5439fefdf13b8872e41ce4e901f892a14ff57e20`. Container revision and `/app/VERSION` match; external `/api/health` returns `ok`, and `/`, `/video`, `/image`, `/admin/settings` return HTTP 200.
- Before deployment, consistent SQLite/data/Compose backups were created: `database-before-v0.19.34-20261013-055856.sqlite`, `data-before-v0.19.34-20261013-055856.tgz`, and `docker-compose.deploy.yml.20261013-055856.bak`. Database `quick_check` passed; settings and all five historical Replicate task records were unchanged, and new channel fields are present. The existing video worker remained running since `2026-10-09T06:50:12.435805303Z`.
- Replicate channel management is now in production. The initial public catalog check incorrectly inspected the response wrapper instead of `data.modelChannel.models`; subsequent verification confirmed enabled Replicate entries including Wan image-to-video. No credentials or paid generation were changed or submitted. Authenticated quotes, channel routing, existing task recovery, and real generation still need business verification.
- Local Go 55-case (including subtests) and frontend 4-case focused verification passed before release; the existing unrelated video test failures were reproduced against the pre-change snapshot. Evidence is beside the checkout in `artifacts/replicate-channel-review/` and `artifacts/release-v0.19.34/`.

## v0.19.35 Wan image-to-video naming deployment verification

- Release commit: `18331b10eb15faa8196f583148a7bed5fea57a01`; tag/release: `v0.19.35`. App Docker workflow succeeded: https://github.com/thinkinwalk/infinite-canvas/actions/runs/38352216940.
- Production image: `ghcr.io/thinkinwalk/infinite-canvas:v0.19.35`; digest: `sha256:5191167fc14476b368e4ea7d4ff58c8b85e7960257f97fba3e49077acef1022b`. Container revision and `/app/VERSION` match. Internal health is `ok`; external health, `/video`, and `/admin/settings` return HTTP 200.
- Public `data.modelChannel.models` now names `wan-video/wan-2.2-i2v-fast` as「通义万相 Wan 2.2 · 图生视频」. Served asset `/assets/index-JYj2F1i6.js` includes the new name and the independent text/image model explanation. The enabled model list is identical to the pre-deployment snapshot; settings and pricing are unchanged.
- Consistent backups: `database-before-v0.19.35-20261013-074120.sqlite`, `data-before-v0.19.35-20261013-074120.tgz`, and `docker-compose.deploy.yml.20261013-074120.bak` under `/opt/infinite-canvas/backups/`. SQLite quick_check is `ok`, all five historical task records retain their existing fields, and video worker start time remains `2026-10-09T06:50:12.435805303Z`.
- No local compilation/tests or paid generation were run during release. The existing CI built the production image; authenticated admin rendering remains available for user verification. Evidence is beside the checkout in `artifacts/release-v0.19.35/`.
