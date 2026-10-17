# Agent guide

Instructions for AI coding agents working in this repository. People should read [CONTRIBUTING.md](CONTRIBUTING.md); everything here applies to them too.

snowy-ffmpeg compiles FFmpeg to WebAssembly modules that browsers call directly from a worker. The output is judged on three things, in this order: **correct** (matches native FFmpeg), **fast** (measured, never assumed), **small**.

## Commands

| Task | Command |
| --- | --- |
| Install tools and the pre-commit hook | `bun install` |
| Build `dist/core` (Docker) | `bun run build` |
| Browser tests (Chromium, Firefox, WebKit) | `bun test` |
| Format everything | `bun run format` |
| All static checks (CI's `check` job) | `bun run check` |
| Demux benchmark | `bun run bench --browsers chromium --runs 3` |
| Regenerate fixtures (needs native FFmpeg 9.0.2) | `bun run fixtures` |

A full FFmpeg build takes 20+ minutes; changing only `src/` relinks in under a minute. Run `bun run check` before every commit; the hook runs it anyway.

## Repository map

| Path | What it holds |
| --- | --- |
| `Dockerfile` | the only build path; every pinned version and checksum |
| `build/configure-core.sh` | FFmpeg configure flags for `core` |
| `src/helpers.c` | the entire JavaScript API of a module (getters, open/read/seek) |
| `src/io.js` | Emscripten imports that route AVIO reads to JavaScript hooks |
| `scripts/gen-dts.ts` | generates `dist/core/index.{js,d.ts}` from `src/helpers.c` |
| `scripts/gen-fixtures.ts` | builds `test/fixtures` and `expected.json` from native `ffprobe` |
| `test/` | Playwright tests; `test/support/` is shared with `bench/` |
| `bench/` | benchmark harness, library adapters, recorded results |
| `tooling/oxlint-rules/` | repository lint rules (see rule 7) |
| `docs/architecture.md` | design and the reasons behind it |

## Rules

1. **The boundary is `src/helpers.c`.** JavaScript never reads FFmpeg memory by offset. A new field is a one-line `API` getter; a new constant is a `SNY_CONST` line. Then run `bun scripts/gen-dts.ts`. Never edit anything in `dist/`. See the `add-api` skill.
2. **Expected results come from native FFmpeg.** Never hand-write a test expectation. Add the case to `scripts/gen-fixtures.ts` and regenerate, so `ffprobe` 9.0.2 decides what is correct.
3. **Performance is measured.** A change that can affect speed or size includes `bun run bench` numbers before and after, from the same machine. Never claim a speed-up you have not measured.
4. **Everything is pinned.** Versions and sha256 checksums live in the `Dockerfile` only; never fetch anything unpinned. When the build output changes, update `dist.sha256` in the same commit and say why in the pull request. See the `update-dependency` skill.
5. **One configuration, no fallbacks.** Every module is built with SIMD, threads and LTO. Do not add non-SIMD, single-threaded or main-thread code paths, feature detection, or browser-specific branches.
6. **Bun and TypeScript only.** Tooling is TypeScript run by Bun. No Node.js or Python scripts; shell only inside the Docker build.
7. **Small, focused diffs.** Change only what the task needs. Match the surrounding style: short functions, comments that explain *why*, SPDX headers on new files. `bun run lint` also enforces the house rules: no classes, no module-level `let` (keep state in a `createX()` factory), `await` into a `const` instead of nesting it or chaining `.then`, no `setInterval`, and a blank line around every multi-line block.
8. **No internal notes in the repository.** No plans, roadmaps, TODO lists, meeting notes or agent scratch files. Rationale for the current design goes in `docs/architecture.md`; user-visible changes go in `CHANGELOG.md` under *Unreleased*.

## Before you open a pull request

1. `bun run check` and `bun test` pass. If you touched the `Dockerfile`, `build/` or `src/`, rebuild and check `shasum -a 256 -c dist.sha256`.
2. Review your own diff with the `code-reviewer` agent (`.claude/agents/code-reviewer.md`) in a fresh context, and fix what it finds.
3. Title the pull request as a Conventional Commit, fill in the template, and say which parts an agent wrote.

## Skills

Task playbooks in [`.agents/skills`](.agents/skills) (also linked into `.claude/skills`):

| Skill | Use it to |
| --- | --- |
| `add-api` | expose a new FFmpeg field, function or constant to JavaScript |
| `fix-format` | reproduce and fix a file that won't open or demuxes wrong |
| `update-dependency` | bump FFmpeg, Emscripten, dav1d, zlib or bzip2 |
| `benchmark` | measure a performance or size change and report it |
| `triage-issue` | label a new issue and ask for what is missing |
