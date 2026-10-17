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
- Current production image: ghcr.io/thinkinwalk/infinite-canvas:v0.19.55
- Current worker source mount: /opt/infinite-canvas/releases/v0.19.55-worker/

Do not commit private key material. The key path above is recorded only so future local Codex sessions can connect through the existing workstation key.

## v0.19.55 new-subject mask aspect tolerance deployment

- Source commit `156fc9ce2e81af44d439e0274af7558937a34702`, annotated tag `v0.19.55`. Docker image workflow succeeded.
- Bug found in production on the user's first v0.19.54 run (task `Z4PayNuylLCTeQYUhcIc8`): the three paid steps (track-mask 100, replace-person 350, new-subject track-mask 100) all completed, then the composite failed with "生成视频画幅比例发生变化，已停止合成". Cause: SAM 2 tracks the new subject on the GENERATED video, so that mask carries the model's fixed size (464x832) while the source is 480x848; the new code validated it with the strict `validate_timeline` instead of the tolerant `validate_masked_generation` used for generated frames. Fixed by using the tolerant check for the new-subject mask too.
- Verified against the same failing task's materials (source `2ae001833deb42dfbc6c28afc17569cd.mp4`, generated `5928fe904fdd42dfb916de275363f252.mp4`, mask `7b502f68efed4ac78022f3ec32cea6d4.mp4`, subject mask `fa9a2fe2980b40a7bde8eba4889c535d.mp4`): the composite now completes with `subjectUnion: true`, `captionProtected: true`, output `4a201652accd4294a2c617ab77279c.mp4`.
- A failed record now resumes the composite only; the paid tracking and generation results are reused, so no re-charge. The test `test_cloud_masked_composite_accepts_wan_animate_size_and_one_frame_short` was extended to pass a 464x832 subject mask so this regression is covered (39 tests pass).
- Worker deploy: `/opt/infinite-canvas/releases/v0.19.55-worker/`, all 6 modules SHA-256 matched, 7 Compose mounts updated, 24 capabilities available. App `/app/VERSION` `v0.19.55`, OCI revision matches, internal and external health 200, SQLite `quick_check` ok.

## v0.19.54 new-subject mask union deployment

- Source commit `5ee3672421d2434b8937c98f7601143d8cf321eb`, annotated tag `v0.19.54`. Docker image and Publish Official Plugins workflows succeeded. No GitHub Release page (`gh` unauthenticated).
- Follow-up to v0.19.53 after the user reported the ghost was still below delivery standard. Root cause re-measured on the user's own sample (source `c70cbcdb8b94407e87b90d11627ab69d.mp4`, Wan-Animate output `bc88f9c0141c447290be0a81076b526e.mp4`, original-subject mask `162e74216f5244c6999905ee5d81ff09.mp4`, 480x848): the model repaints the whole frame, not just the subject, so pixel difference cannot separate the new subject from a repainted background; the tracked mask follows the OLD silhouette; the remaining ghost is a hairline seam along the subject outline.
- Fix: the workflow now runs a SECOND SAM 2 track (`track-mask`) on the generated video using the same click region, and the worker unions the two masks, then grows the union 2px outward. The pixel-difference heuristic (`grow_mask_to_subject`) is skipped when a real second segmentation is present. The 2px value was measured: it removed ~77% of the seam pixels on the real sample with zero background pulled in.
- Measured result on the user's sample (single frame, using the production composite_masked_frames): ghost pixels dropped from 8756 (2.15% of frame) to 1128 (0.28%), a ~87% reduction.
- New boundary values, reported to and approved by the user: union outward growth `SUBJECT_EDGE_GROW = 2` px; two tracks plus one generation in quoting.
- Cost note: this adds a second `track-mask` charge (~100 credits) per masked-person job. The user approved this.
- Tests: 39 worker tests pass in the production image (16 in `test_replacement_engines`, including two new union/empty-subject cases, plus 23 across `test_replacement`/`test_replacement_subtitles`), run from a `/tmp` copy with `VIDEO_WORKER_DATA` in a temp dir. Frontend `tsc --noEmit` shows only the 3 pre-existing unrelated errors.
- Worker deploy: `/opt/infinite-canvas/releases/v0.19.54-worker/` (6 mounted modules + adapters copy), all 6 SHA-256 matched, 7 Compose mounts sed-replaced, worker restarted; 24 capabilities available and `composite_masked_frames` exposes the `secondary` parameter.
- App: digest `sha256:4f0e32b18542eb1e5c1a1cf1eeceac43186dec74b709b39357c241f1db9b2db8`; `/app/VERSION` `v0.19.54`, OCI revision matches. Internal/external health 200. SQLite `quick_check` passed; counts 2/32/23; all 60 worker job records byte-identical.
- A temporary public copy of the generated video used for the SAM 2 validation was created under `data/reference-media/_tmp_verify_subject.mp4` and has been deleted. The validation prediction was made directly against the Replicate API with channel 17's key and did not create a站内 task or charge user credits.

## v0.19.53 masked-composite mask growth and caption protection deployment

- Source commit `e5afc3f513f6ac73483177cead3d919efce4d39b`, annotated tag `v0.19.53`. Application image workflow succeeded (Docker image and Publish Official Plugins). No GitHub Release page was created (`gh` unauthenticated).
- Two user-reported defects on the v0.19.51 online sample (task `4POhIkY1Wy04i_jYkzm1Z`): a caption burned onto the subject was erased, and a ghost outline of the old subject showed around the person.
- Diagnosis, measured on the actual sample (source `b57b9cb8731145178e1ba0ff887beb01.mp4`, Wan-Animate output `e68ef5e83c094125ba5199ca2fb21133.mp4`, SAM 2 mask `c2a1b09499014754a58bb4795e61cca4.mp4` at 480x848): the caption sat 98% inside the tracked mask, so the generated redraw replaced it; 42.7% of the pixels the model changed strongly lay outside the tracked mask, 37% of the subject was cropped, and the tracked mask followed the OLD silhouette (the new subject sat offset), which left the old outline visible. Feather was a fixed 2 px.
- Fix (worker): `composite_masked_frames` unions the tracked mask with the pixels the model actually redrew near it (`grow_mask_to_subject`: mean-channel threshold 40, 8 px dilation window around the tracked mask, hard stop above 1.5x tracked area), feathers by frame width (1.5%, ~7 px at 480) instead of a fixed 2 px, and restores burned-in caption glyphs from the source (`protect`). Caption lookup (`caption_lane_boxes` + `caption_boxes_for_composite`) is best effort and never fails the job; it reuses the existing PaddleOCR adapter. Application passes `protectCaptions: true` for this path.
- Honest limitation, told to the user: mask growth only reaches the pixels the model redrew within 8 px of the tracked mask. On this sample the union grew 30.8% -> 32.6%, so the ghost fades rather than disappears where the new subject is offset from the old. Full removal needs a soft alpha from a matting model; RVM on Replicate (~$0.029/run) is the chosen next step, still to do.
- Tests: 37 worker tests pass in the production image (14 in `test_replacement_engines`, 23 across `test_replacement` / `test_replacement_subtitles`), run from a copy under `/tmp` with `VIDEO_WORKER_DATA` pointed at a temp dir, so no production data was touched.
- Worker deploy: new source dir `/opt/infinite-canvas/releases/v0.19.53-worker/` (the 6 mounted modules plus a copy of `adapters/`), all 6 files SHA-256 matched to the repo, 7 Compose mounts sed-replaced from `v0.19.51-worker`, `docker compose up -d --no-deps video-worker`. Health returns 24 available capabilities including `replacement-masked-composite`, `ocr` and `replacement-prepare`.
- App: image digest `sha256:5e7ac5f650efc9c7e449b03eeef006129ce321f01281c7b3af6d86c8b65f133b`; `/app/VERSION` is `v0.19.53` and the OCI revision matches the commit. Internal and external health HTTP 200 `ok`. `/video/content-replace` serves `/assets/index-Bzb5bOOj.js`.
- Backups: `/opt/infinite-canvas/backups/v0.19.53-20261016-123735/` (online SQLite backup + record hashes) plus the image helper backups. SQLite `quick_check` passed; settings/video-task/Replicate-task counts 2/32/21; all 59 worker job records byte-identical after deployment. No paid task was submitted by this deployment.

## v0.19.52 rejected cloud task resubmission deployment

- Source commit `caa128207876d1e6d81eb6becad83c262b82f70f`, annotated tag `v0.19.52`. Application image workflow [38852428814](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38852428814); docs image and official plugins workflows also succeeded and GitHub Pages was skipped. No GitHub Release page was created (`gh` unauthenticated).
- Cause: `submitCloudTask` wrote the task id into the local record before calling the create API. When creation was rejected (task `4POhIkY1Wy04i_jYkzm1Z-animate`, "算力点不足": the 100-credit SAM 2 track had left 112 credits against a 350-credit Wan-Animate charge), no server task existed, so "恢复任务结果" polled a missing id, got HTTP 404 and stayed interrupted. The same stuck record also blocked new submissions.
- Fix: clear the local task id and masked-replacement phase when creation fails, and on a `ReplicateTaskNotFound` during recovery resubmit with the same idempotency key (the id is the server-side key, so a repeat creates and charges only once). Application-only change; the worker was not touched and stays on the v0.19.51 source mount.
- App: image digest `sha256:77b7f1da235a8488121664e104fa0b06435af6fce88ca678578ade11be8496e0`; `/app/VERSION` is `v0.19.52` and the OCI revision matches the commit. Internal and external health return HTTP 200 `ok`. `/video/content-replace` serves `/assets/index-BylAeIC8.js`.
- Backups: `/opt/infinite-canvas/backups/v0.19.52-20261016-071913/` (online SQLite backup, previous Compose, worker job and replacement job archives, SHA-256 of 64 task records). Image helper backups `docker-compose.deploy.yml.20261016-073241.bak` and `data-before-deploy-20261016-073241.tgz` (run from a temporary copy tolerating tar live-file warnings; host script unchanged). SQLite `quick_check` passed; settings/video-task/Replicate-task counts 2/32/20; all 64 task records byte-identical after deployment. No paid task was submitted by this deployment.
- Outstanding for the user: the stuck record's 100-credit SAM 2 track mask is still saved, so recovery only needs to resubmit the 350-credit Wan-Animate generation with the user's confirmation. The earlier VACE chain (`i6iRv3H6x9-TGorJsFSbm`, 100 + 100 credits, completed, not auto-refunded) still awaits a manual refund decision.

## v0.19.51 masked person replacement via Wan-Animate deployment

- Source commit `dd4a9e904923aac71fa1f9a787909a36817ca3aa`, annotated tag `v0.19.51`. Application image workflow [38834774583](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38834774583), docs image workflow [38834774495](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38834774495) and official plugins workflow [38834774568](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38834774568) succeeded; GitHub Pages was skipped. No GitHub Release page was created (`gh` unauthenticated).
- Cause: VACE prediction `wtzwscbrfxrn80d180kvv1x5p8` received the source video with the original person pixels and no gray fill in the masked area, so the person was not replaced (masked-area change comparable to the unmasked area). The cloud masked person route now uses SAM 2 tracking, Wan-Animate `replace-person` generation and worker compositing of only the tracked person over the source. VACE is no longer called for masked person replacement. Observed Wan-Animate output for 480x848@30 sources is 464x832@30 with 149 frames.
- Worker: source extracted from the tag (`git archive`) into `/opt/infinite-canvas/releases/v0.19.51-worker/`; only `app.py` and `replacement.py` differ from v0.19.49. All seven Compose source mounts were switched from `v0.19.49-worker`; image, models, data mounts and environment were retained. The masked composite now accepts same-orientation output within 3% aspect difference (scaled onto the source canvas) and up to 0.25 s duration difference (tail frames dropped or last frame repeated); larger differences still stop. Worker restarted at `2026-10-16T01:29:53Z`; health returns 200 and all `replacement-*` capabilities, including `replacement-masked-composite`, are available. Before deployment, 41 worker tests passed in the production worker image against a scratch copy (no production data used).
- App: image digest `sha256:31d7ed905bfd5c191f0003031c6320518570f071bd26a8ce4f258dccd98bcac9`; `/app/VERSION` is `v0.19.51` and the OCI revision matches the commit. Internal and external health return HTTP 200 `ok`. `/video/content-replace` serves `/assets/index-CCXBD5yp.js` containing the tracking + person generation quote and new masked-mode copy; the v0.19.50 VACE 5-second block is absent and the out-of-memory hint remains.
- Backups: `/opt/infinite-canvas/backups/v0.19.51-20261016-032846/` (online SQLite backup, previous Compose, worker job and replacement job archives, SHA-256 of 64 task records). Image helper: `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261016-041251.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261016-041251.tgz` (run from a temporary copy tolerating tar live-file warnings; host script unchanged). SQLite `quick_check` passed; settings/video-task/Replicate-task counts remain 2/32/19; all 64 task records are byte-identical after deployment. No worker or Replicate task was active and no paid prediction was submitted.
- Awaiting user acceptance: a real tracked + Wan-Animate sample for identity, edges where the new person's outline differs from the source mask, background/subtitle/audio preservation and actual cost. The earlier VACE-based job (`i6iRv3H6x9-TGorJsFSbm`, 100 + 100 credits, not auto-refunded) will resubmit Wan-Animate if resumed; its VACE output is not reused.

## v0.19.50 masked replacement duration guard deployment

- Source commit `4dda8dc1bb1f83c07e8cc822cb1da7dad19d904e`, annotated tag `v0.19.50`. Application image workflow [38755042901](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38755042901), docs image workflow [38755042891](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38755042891) and official plugins workflow [38755042884](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38755042884) succeeded; GitHub Pages was skipped by its repository condition. No GitHub Release page was created because `gh` is not authenticated on this workstation. The upstream `v0.20.0` tag fetched from `basketikun` is not on this fork's `main` and does not define this release line.
- Deployed image digest `sha256:1d793784204c7b7742d029326fb000f19a1d964b46313fa659c304f10a0e07ed`; container `/app/VERSION` is `v0.19.50` and the OCI revision matches the commit. Internal and external health return HTTP 200 `ok`. `/video/content-replace` serves `/assets/index-CNj3hqwn.js` containing the 5-second masked-replacement block and the out-of-memory hint.
- Change: frontend only. Cloud masked person replacement now blocks inputs above 81 frames (16 fps, about 5 seconds) before quotation/submission, and `CUDA out of memory` is shown as a Chinese hint. The cause was a VACE-14B prediction that hit out-of-memory on an 80 GB GPU after the full source duration was submitted; credits were refunded. The worker was not changed and kept its original start time.
- Online SQLite backup: `/opt/infinite-canvas/backups/database-before-v0.19.50-20261015-165900.sqlite`. Image helper backups: `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261015-170247.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261015-170247.tgz`. The first helper run aborted before changing Compose because `tar` exited on a live SQLite write; that partial archive was removed and the helper was rerun from a temporary copy with tar file-change/removal warnings tolerated (the host script is unchanged). The consistent SQLite backup above is the authoritative database copy. SQLite `quick_check` passed; settings/video-task/Replicate-task counts remain 2/32/15. No Replicate task was running and no paid prediction was submitted.
- Awaiting user acceptance: inputs over 5 seconds are blocked, inputs within 5 seconds still quote, and 480p vs 720p at 81 frames to see whether 720p also runs out of memory.

## v0.19.49 cloud masked replacement deployment

- Source commit `89b9d808343892d7f2e0fea25988af0636056a58` and annotated tag `v0.19.49` are pushed. Experimental prerelease: https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.49.
- The owner re-enabled inherited workflows on the fork's Actions homepage. This resolved HTTP 422 `Actions has been disabled for this repository` despite repository permissions already reporting `enabled: true` and individual workflows `active`. The existing tag was retained and workflows were dispatched against `v0.19.49`.
- Application image workflow [38711448279](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38711448279), docs image workflow [38711454718](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38711454718), and official plugins workflow [38711460878](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38711460878) all succeeded. GitHub Pages was not dispatched for this deployment.
- Deployed application image `ghcr.io/thinkinwalk/infinite-canvas:v0.19.49`, digest `sha256:d7f050cc3b47c858b51a582c165d134d6d2bdef248b7e9e43567e5d3ad2049d0`; container `/app/VERSION` and OCI revision match the release tag and source commit. Internal/external health return HTTP 200 `ok`. The production content-replacement page serves `/assets/index-igrN4Yn7.js` containing v0.19.49, the masked-person toggle, cloud-mode copy and masked-composite operation. These resource checks do not replace interactive or real-model acceptance.
- Worker source mounts now point to `/opt/infinite-canvas/releases/v0.19.49-worker/`; existing image, CPU dependencies, model/data mounts and environment were retained. `replacement-masked-composite` and the previously available subtitle preparation, transcription and rendering capabilities are available. The separate local GPU masked-person engine remains unconfigured; the new cloud route uses Replicate for SAM 2/VACE and the CPU worker for compositing.
- Consistent SQLite backup, full data/environment/Compose backup, previous worker source and task snapshots are in `/opt/infinite-canvas/backups/v0.19.49-20261015-111842/`. The image helper additionally saved `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261015-111901.bak` and `/opt/infinite-canvas/backups/data-before-deploy-20261015-111901.tgz`. SQLite `quick_check` passed; settings/video-task/Replicate-task counts remain 2/32/13. All 57 worker JSON records and 6 replacement-job records remained byte-identical, and stored settings remained unchanged.
- After the user approved test enablement, channel #17 gained `meta/sam-2-video`; SAM 2 and VACE pricing are now enabled at 6 credits per second with a 100-credit minimum per operation (200 credits total for a known 5-second input). These are agreed experimental platform prices; actual upstream cost is not verified. No paid prediction was submitted. Public settings expose both model operations and SQLite `quick_check` passes; authenticated quotation and the existing browser tab still need user acceptance. Pricing backup: `/opt/infinite-canvas/backups/database-before-masked-test-enable-20261015-101840.sqlite`; sanitized change record: `/opt/infinite-canvas/releases/masked-test-pricing-enable-20261015-101840.json`. Deployment evidence is beside the checkout in `artifacts/release-v0.19.49/` and on the host in `/opt/infinite-canvas/releases/v0.19.49-deployment.json`.

## v0.19.48 historical task archive deployment

- Release commit `96cb03c3cb598caf0298ee99ba6c091b13d3bf2b`, tag `v0.19.48`, and [GitHub Release](https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.48). Docker image workflow [38600754128](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38600754128), docs image workflow [38600754063](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38600754063), and official plugins workflow [38600754141](https://github.com/thinkinwalk/infinite-canvas/actions/runs/38600754141) succeeded; GitHub Pages was skipped by its repository condition.
- Deployed image `ghcr.io/thinkinwalk/infinite-canvas:v0.19.48`, digest `sha256:605f166f6988e27a2ec0d438e420fb782fe4db8a425f238dcc8985e5cb365561`; container `/app/VERSION` and image revision match the tag and release commit. Internal and external health return `ok`; `/video/content-replace` returns HTTP 200 and serves the history/archive controls and v0.19.48 bundle.
- SQLite `quick_check` passed; `video_tasks`, `replicate_tasks`, and `settings` counts remain 29, 13, and 2. Online SQLite backup: `/opt/infinite-canvas/backups/database-before-v0.19.48-20261014-184745.sqlite`; deployment data and Compose backups: `/opt/infinite-canvas/backups/data-before-deploy-20261014-185606.tgz` and `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261014-185606.bak`.
- App deployment used the existing image helper. The video worker remained running with its original start time; no paid model call was submitted. Evidence is beside the checkout in `artifacts/release-v0.19.48/`. Real-account cross-browser archive synchronization and historical media loading remain for user acceptance.

## v0.19.47 editable captions release

- Deployed revision `7e26f4e5433cf2448420f68b8e9be0d675e4b491`, image digest `sha256:416e0cb90a9d912ab5e8c9f97b87b084557a56dd616fa1a945ca46b0f606481f`. App CI https://github.com/thinkinwalk/infinite-canvas/actions/runs/38594017768 succeeded; docs and plugins also succeeded. Release https://github.com/thinkinwalk/infinite-canvas/releases/tag/v0.19.47.
- Production health returns text `ok`; content replacement returns HTTP 200 and serves `/assets/index-B2S5CBWW.js` containing the caption editor/actions/version. SQLite quick_check is `ok`; 29 video tasks, 13 Replicate tasks and 2 settings rows match the database backup. No paid model call was submitted. Browser interaction and actual edited-caption render remain for user acceptance.
- Worker source mounts now point to `/opt/infinite-canvas/releases/v0.19.47-worker/`; new modules and adapters are mounted read-only. All 47 worker JSON task records remained byte-identical. Required cleanup/transcribe/render capabilities are available. Worker backup: `/opt/infinite-canvas/backups/worker-v0.19.47-20261014-175958/`.
- App backups: `/opt/infinite-canvas/backups/database-before-v0.19.47-20261014-180340.sqlite`, `/opt/infinite-canvas/backups/data-before-deploy-20261014-180341.tgz`, `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261014-180341.bak`. Worker rollback uses the separate worker backup; preserve the selected app image when restoring worker mounts. Deployment evidence: `/opt/infinite-canvas/releases/v0.19.47-app-deployment.json` and `v0.19.47-worker-deployment.json`; local copies beside the repository in `artifacts/release-v0.19.47/`.

- New whole-video person jobs preserve the clean video and original audio, store editable ASR captions, and render a separate captioned copy after online correction. Single-clip and existing jobs retain their saved workflows. Caption edits/rendering do not invoke paid person generation.
- Worker must mount the complete released Python source, including replacement_subtitles.py, replacement_masks.py and remote_subtitles.py, while preserving CPU LaMa, OCR cache, text dependencies and model/data mounts. SAM 2 / Wan / VACE GPU engines remain unconfigured.
- Existing checks: Go handler passed; 15 worker subtitle regression cases passed. Three unrelated TypeScript baseline errors remain. Release-time local builds/tests are omitted per AGENTS.md; CI builds the image. Actual production caption editing/rendering and complex-caption quality await user acceptance.

## v0.19.46 replacement repair deployment

- App revision `e56f073af81138ae5a85d226bcceea4cfffc52b5`, image digest `sha256:88446bb05bad449c9bb22f26b9e0b839c29bc6d815a6a1783d96686407c1fa11`. Application workflow https://github.com/thinkinwalk/infinite-canvas/actions/runs/38510928068 succeeded, as did docs and official plugins. Public page serves `/assets/index-bkqnl3wO.js`; independent unauthenticated Chrome verified the subtitle default is on, updated segmentation text, unified-caption explanation, HTTP 200 and no page errors.
- Internal/external app health and SQLite quick_check passed. Before/after table counts: 25 video tasks, 9 Replicate tasks, 2 settings rows. Existing background jobs remain completed / ready; their old plans and subtitle settings are preserved. New analysis is required for new segmentation. No paid generation was submitted for this release.
- App backups: `/opt/infinite-canvas/backups/database-before-v0.19.46-20261014-042558.sqlite`, `/opt/infinite-canvas/backups/data-before-deploy-20261014-062600.tgz`, `/opt/infinite-canvas/backups/docker-compose.deploy.yml.20261014-062600.bak`.
- Worker source is mounted read-only from `/opt/infinite-canvas/releases/v0.19.46-worker/`: `app.py`, `replacement.py`, `subtitle_matching.py`, and the complete `adapters/` directory. This replaces the older identity-only source mount below. App source SHA256 `5700cd02d67defd677b90a847ae56fcc9aef0c2153a14b8ad0fb633d7f8daf3b`. Worker backup `/opt/infinite-canvas/backups/worker-v0.19.46-20261014-042242/` includes the previous Compose and all 38 worker job records; all remained byte-identical across replacement. No job was running. Worker start time `2026-10-14T04:22:47.062341692Z` remained unchanged during app deployment.
- Persistent CPU LaMa: `/opt/infinite-canvas/video-worker-data/engines/lama/venv`, `torch==2.5.1+cpu`, `torchvision==0.20.1+cpu`, `simple-lama-inpainting==0.1.2 --no-deps`, `big-lama.pt` (205803670 bytes, upstream adapter v0.1.0 release), plus both upstream license files. The isolated venv uses the existing worker system packages; dependency compatibility has been tested for inference, not represented as a clean independent pip dependency solve.
- `VIDEO_ENGINE_CONFIG=/data/engines/lama/engines.json`; OpenCC 0.1.7 is installed at `/data/engines/text/python` and supplied via `PYTHONPATH`. Paddle cache is persisted at `/opt/infinite-canvas/video-worker-data/engines/paddlex` mounted to `/root/.paddlex`; source-check disabling is configured. Preserve these mounts and variables on redeploy. The production cached OCR models are PP-OCRv6 medium detection/recognition. No image was built on production.
- Actual post-restart inference passed: LaMa erased a test caption; OCR found no remaining text; all pixels outside the mask matched the input exactly. The real 15-second source planned as a single part with `preserveScenes=false` under worker job `7470c866-0c3b-4abf-856e-a9af6f972f5f`; repeat submission reused its ID.
- A constructed 3.5-second / 2 fps fixture using source speech and clear Chinese captions passed complete prepare/finish, OCR text/time, timeline and restored audio steps. Preparation took 146.15 seconds on this CPU host; this is not a real-time or 3-minute throughput claim. The actual 15-second animated-caption source, rehearsed at 2 fps, failed residual OCR inspection; partial/unmatched captions and residual text now stop the affected part before paid generation. Complex animated-caption quality remains unresolved. The model may still create new text after preparation; outputs require human review.
- Go replacement tests, Python 11 tests, frontend 4 tests and Vite build passed. Mocked browser checks verified automatic preview, refreshed local media, stale-download protection, one failed download without a retry loop, and unavailable-subtitle blocking. Typecheck retains three unrelated baseline failures (viral-recreate-workspace, use-config-store, use-home-draft-store). Identity/lip-sync/empty-scene verification is manual, not a newly deployed automatic detector.
- Evidence is in `artifacts/replacement-fixes/` beside the repository. Host deployment/verification JSON records are `/opt/infinite-canvas/releases/v0.19.46-worker-deployment.json` and `/opt/infinite-canvas/releases/v0.19.46-verification.json`. To roll back only the worker, restore its service mounts/environment from the worker Compose backup while retaining the selected app image; restoring that entire old Compose would also revert the app image.

## Worker task identity hotfix after v0.19.45 (historical)

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
