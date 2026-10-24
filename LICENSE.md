# Licensing

This repository holds code under several licences. Every file names its own in an SPDX header, or in [REUSE.toml](REUSE.toml) when it can't carry one; that is what applies. The texts are in [LICENSES/](LICENSES).

| What | Licence |
| --- | --- |
| `packages/engine`, `packages/sync`, `packages/timeline`, and every other package except `packages/ffmpeg` | [Snowy License 1.0](LICENSES/LicenseRef-Snowy-License-1.0.txt) |
| `packages/ffmpeg`, FFmpeg compiled to WebAssembly | [LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt), like FFmpeg; its [NOTICE](packages/ffmpeg/NOTICE) lists the bundled third-party code |
| The logo and image files in `brand/` | [All rights reserved](LICENSES/LicenseRef-Snowy-Brand.txt); see [TRADEMARKS.md](TRADEMARKS.md) |
| Everything else: repository tooling (`tooling/`, `scripts/`, `.github/`, `.githooks/`, `.agents/`), configuration and documents at the root, and `brand/README.md` | [MIT](LICENSES/MIT.txt) |

## The Snowy License in brief

This summary is not the licence; [the licence text](LICENSES/LicenseRef-Snowy-License-1.0.txt) governs.

- **Free** for individuals, for companies with at most 3 people (owners who work in them, employees and contractors, counted with affiliates), for non-profits and education, for open-source projects, and for any company's evaluation and development.
- **A company licence** is needed for anything else, such as a larger company using Snowy in production.
- **Build anything** with it, including products that compete with Snowy's own apps. People who use your product need no licence of their own.
- **Never sell Snowy itself** as an SDK, library, framework or toolkit whose main value is Snowy's own functionality, with or without a company licence.
- **The project format and agent tool interface are open.** Software that contains no Snowy code may read and write Snowy projects and call Snowy's agent tools without any licence.
- **What you make is yours.** The licence claims nothing in your media, projects or output.

Snowy's code is source-available, not open source: you can read, build and change it, but the licence limits commercial use, so it is not an [Open Source Initiative](https://opensource.org/licenses) licence.

## Company licences

A company licence is annual, and covers either one product and the packages it uses, or an organisation's own internal use. To get one, email the maintainer at [pksn1111@gmail.com](mailto:pksn1111@gmail.com).

## Earlier releases

`@snowy-media/engine` 0.1.0 and earlier, and copies of `engine`, `sync` and `timeline` taken before they moved to the Snowy License, were released under MIT and stay under it. Later releases are under the Snowy License 1.0.

## Contributions

Contributions are accepted under the [Contributor License Agreement](CLA.md), which lets the maintainer license them under any terms, including the licence of the files they change and company licences. [CONTRIBUTING.md](CONTRIBUTING.md#licensing) explains how to sign it.
