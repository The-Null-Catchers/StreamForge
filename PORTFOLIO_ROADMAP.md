# StreamForge portfolio roadmap

Baseline reviewed on November 17, 2026. Repository roadmap published on November 18, 2026.

This roadmap applies to this repository and follows the shared Null Catchers portfolio plan. Verify the documented state against the current code and runs before starting work.

**Estimated initial demo effort** 30–50 hours for a developer familiar with the project. The estimate excludes external reviews, store accounts, target environment setup, and later milestones.

## Project priorities

**Documented state** The project implements resumable uploads, direct multipart and tus, FFmpeg, HLS/CMAF, audio tracks, subtitles, and analytics. Full browser coverage, Flutter verification, and external providers remain milestones.

**P0 — Demo** Verify signup, email verification, direct upload recovery, and playback with a generated or owned test video. Check uploaded hashes, output media, CORS, and ETag on the target store.

**P1 — Validation and depth** Change quality, audio, and subtitles. Verify token renewal and revocation after deletion. If a test HTTPS hook receiver is available, measure retry after a transient failure. Report processing and playback startup under a known setup.

**P2 — Later** Consider integrity-quarantine recovery, mobile parity, and live streaming. Full RTMP/SRT support is outside the first VOD demo.

**Acceptance criteria** Retry creates one upload, readiness requires all segments, authorized playback resumes after renewal, and deletion revokes access according to the published contract.

**Demo scenario** Upload → disconnect → resume → transcode → change quality or subtitles → webhook. [Capability Matrix](https://github.com/The-Null-Catchers/StreamForge/blob/main/docs/status.md), [Uploads](https://github.com/The-Null-Catchers/StreamForge/blob/main/docs/upload-system.md).

## Next milestones

The [upload guide](docs/upload-system.md) and [feature status](docs/status.md) document direct upload and file size and hash checks.

1. [ ] Use a generated video, disconnect after the first part uploads, and resume in the same browser. Match the original size and hash.
2. [ ] Check CORS and ETag in the test store. Wait for readiness and verify playback starts and shows the right duration.
3. [ ] Record the run with browser, storage target, and SHA. Document whether target-provider verification has run.

## Portfolio acceptance checklist

- [ ] Another person can reproduce the primary workflow from a clean checkout using the README and test credentials or fixtures.
- [ ] The demo tells one complete story with a defined user, problem, and saved result.
- [ ] Tests cover the main flow, an important failure, and access boundaries when multiple accounts are involved.
- [ ] Demo data is labeled synthetic and reproducible. Review screenshots and recordings for secrets and customer data.
- [ ] Include four to six real screenshots where appropriate, a 60–120 second recording, and working links. Identify the revision used for capture.
- [ ] The README describes implemented capabilities, setup, architecture, limits, tests, and the demo.
- [ ] A short case study explains two engineering decisions, a considered alternative, and how the system handles an actual failure.
- [ ] Release evidence records the commit SHA, CI, prerequisites, and limits. Performance data includes workload, hardware, and method.
- [ ] Licensing and contributor attribution are settled before distribution. Choose the license for each repository individually.

A hosted demo is optional. Code execution, server administration, and secret management can be demonstrated through a recording and a reproducible isolated environment. Keep public demo access scoped to the activities it needs.

## Implementation and follow-up

- Break P0 into tasks with expected behavior, acceptance criteria, and a suitable test.
- Verify existing functionality first. Update this plan when evidence tied to a commit or PR closes a milestone.
- Record the fixture source, the revision used for evidence, and the tested limits.
- Review the final diff and verify required checks for its exact SHA before merging. Follow branch protection.
- For documentation-only changes with no applicable workflow, verify content and links and record the checks actually performed.
- Tie performance, security, and readiness claims to supporting evidence.
