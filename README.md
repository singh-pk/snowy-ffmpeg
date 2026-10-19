# Snowy

[![ci](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![REUSE compliant](https://img.shields.io/badge/REUSE-compliant-green)](https://reuse.software)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/singh-pk/snowy-media/badge)](https://scorecard.dev/viewer/?uri=github.com/singh-pk/snowy-media)

Snowy is a frontend-only media toolkit for the browser: a video player that plays every format, and later an editor, running entirely on the page with no server. This repository holds its packages, published on npm under `@snowy-media/`.

## Packages

| Package | What it is | Licence |
| --- | --- | --- |
| [`@snowy-media/engine`](packages/engine) | The playback pipeline: demuxing, decoding, an audio clock and WebGPU rendering in workers (in development) | [MIT](LICENSE) |
| [`@snowy-media/ffmpeg`](packages/ffmpeg) | FFmpeg 9 compiled to small, lazily loaded WebAssembly modules for demuxing and decoding | [LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt) |

Each package has its own README, documentation in `docs/` and CHANGELOG.

## Contributing

Issues and pull requests are welcome, from people and from AI agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; agents start at [AGENTS.md](AGENTS.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Each package states its licence above and in its `package.json`. Everything outside `packages/ffmpeg`, including the repository tooling, is [MIT](LICENSE).
