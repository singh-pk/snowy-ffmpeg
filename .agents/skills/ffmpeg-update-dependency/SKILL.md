---
name: ffmpeg-update-dependency
description: Bump a pinned native dependency (FFmpeg, Emscripten, dav1d, zlib, bzip2) in the Dockerfile with verified checksums, then rebuild, test and benchmark. Use when a new upstream release is out.
---

# Update a pinned dependency

Paths and commands are relative to `packages/ffmpeg/`.

Every native dependency is pinned in the `Dockerfile` `ARG`s by version and sha256. Dependabot does not touch them.

1. **Read the release notes** for security fixes, API removals and changed defaults. Note anything that affects `src/` or `build/configure.sh`.
2. **Get the checksum from the upstream artefact**, not from a mirror:
   - FFmpeg: download `ffmpeg-X.Y.Z.tar.xz` and its `.asc` from ffmpeg.org, verify with `gpg --verify` against `keys/ffmpeg-devel.asc`, then `shasum -a 256`. If the signing key changed, stop and ask a maintainer.
   - Emscripten: pin the `emscripten/emsdk:X.Y.Z` image by its index digest (`docker buildx imagetools inspect`).
   - Others: the release tarball's sha256, checked against the project's published hash where one exists.
3. **Update the `ARG`s together** (version and checksum in one edit).
4. **Rebuild from scratch:** `bun run build`. Fix compile errors in `src/` with public API only. A getter that no longer compiles is the boundary doing its job.
5. **Verify:**
   - `bun test` in Chromium. For an FFmpeg bump, regenerate fixtures with the matching native `ffprobe` (`bun run fixtures`) and review every changed expectation.
   - `bun run bench --runs 3` before and after; report any change above 5%.
   - `shasum -a 256 dist/{core/core,audio-ext/audio-ext,video/video,video-ext/video-ext}.{js,wasm} > dist.sha256`.
6. **Document** the bump in `CHANGELOG.md` and the README's version badge, and title the pull request `build(deps): ffmpeg 9.0.3`.
