# Contributing

Thanks for helping. This guide is for people and AI agents alike; agents also read [AGENTS.md](AGENTS.md).

## Ways to help

- **A file that won't open, or opens wrong:** use the [format issue form](https://github.com/singh-pk/snowy-ffmpeg/issues/new?template=format.yml). A small sample file is the most useful thing you can attach.
- **A bug in the build, API or tooling:** use the [bug form](https://github.com/singh-pk/snowy-ffmpeg/issues/new?template=bug.yml).
- **An idea:** open a [feature request](https://github.com/singh-pk/snowy-ffmpeg/issues/new?template=feature.yml) before writing code, so we can agree on the shape first.
- **A security problem:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Docker with buildx, and [Bun](https://bun.sh) (the version in `package.json`). Everything runs on Bun; there is no Node.js or Python tooling.

```sh
bun install                 # also enables the pre-commit hook
bun run build               # FFmpeg → dist/<module> for each module (the first build takes a while)
bunx playwright install     # browsers for the tests, once
bun test                    # Chromium, Firefox, WebKit
```

The repository checks in CI also run locally if you install the tools (`brew install actionlint shellcheck shfmt hadolint typos-cli zizmor`):

```sh
actionlint && zizmor --offline .github && shellcheck build/*.sh .githooks/* \
  && shfmt --diff build .githooks && hadolint Dockerfile && typos
```

## Make the change

- **Keep it small.** One concern per pull request. A focused 50-line PR is reviewed the same day; a 1,000-line one waits.
- **Follow the boundary rules** in [docs/architecture.md](docs/architecture.md): JavaScript reads FFmpeg data only through getters in `src/*.c`, never by offset.
- **Prove it.** A behaviour change comes with a test. A demuxing fix adds a fixture to `scripts/gen-fixtures.ts`, so its expectation comes from native `ffprobe`. A performance change shows `bun run bench` numbers before and after.
- **Format and lint** with `bun run format` and `bun run check`. The pre-commit hook runs the same check as CI. Besides oxlint's own rules, [`tooling/oxlint-rules`](tooling/oxlint-rules) enforces a few house rules; AGENTS.md lists them.
- **Update [CHANGELOG.md](CHANGELOG.md)** under *Unreleased* for anything a user would notice. CI requires an entry for `feat`, `fix` and `perf` pull requests; a maintainer adds the `no-changelog` label when nobody outside the repository would notice.

### Updating a pinned dependency

FFmpeg, Emscripten, dav1d, zlib and bzip2 are pinned in the [Dockerfile](Dockerfile) by version and sha256 (FFmpeg also by signing key; Emscripten by image digest). To bump one, change the version and checksum together, rebuild, run the tests and the benchmark, and update `dist.sha256` with `shasum -a 256 dist/{core/core,audio-ext/audio-ext,video/video,video-ext/video-ext}.{js,wasm} > dist.sha256`. The `update-dependency` skill in `.agents/skills` walks through it.

## Commits and pull requests

Pull requests are squash-merged, and the title becomes the commit on `main`, so it must be a [Conventional Commit](https://www.conventionalcommits.org): `type(scope): summary` in lowercase imperative, for example `fix(core): keep pts when seeking raw H.264`. Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. CI checks the title.

Fill in the pull request template. Every pull request needs green CI and a review from a code owner.

### AI-assisted contributions

Welcome, on the same terms as any other: you are responsible for every line, and you must understand and be able to explain it. Say in the pull request which parts an agent wrote. The repository ships agent instructions ([AGENTS.md](AGENTS.md)), task skills (`.agents/skills`) and a reviewer agent (`.claude/agents/code-reviewer.md`) so agents follow the same rules people do.

## Releasing

Maintainers release from `main`, in a pull request and then a tag:

1. In a pull request, set `version` in `package.json` and rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - date`, with a new empty `## [Unreleased]` above it and the links at the bottom updated. Merge it.
2. Tag the merge commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

[`release.yml`](.github/workflows/release.yml) then rebuilds the modules without a cache, checks them against `dist.sha256`, creates the GitHub release with the changelog section and the source archive ([`scripts/release.ts`](scripts/release.ts)), and publishes to npm with provenance through [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token exists anywhere.

## Licensing

By contributing you agree that your contribution is licensed under [LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt). Every new source file starts with SPDX headers:

```c
// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
```

CI runs [REUSE](https://reuse.software) to check this.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
