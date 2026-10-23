<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/singh-pk/snowy-media/main/brand/mark-dark.svg">
  <img src="https://raw.githubusercontent.com/singh-pk/snowy-media/main/brand/mark.svg" alt="Snowy" height="48">
</picture>

# @snowy-media/timeline

[![ci](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/singh-pk/snowy-media/blob/main/LICENSE)

The edit document of the [Snowy](https://github.com/singh-pk/snowy-media) editor: a magnetic timeline whose storyline closes up by itself and whose connected clips move with what they belong to, the typed operations that change it, and one linear history that every person and agent editing a project shares, with undo, revert and branches. It has no DOM, network or media, so it runs in Bun as well as the browser; [`@snowy-media/engine`](../engine) plays what it describes and [`@snowy-media/sync`](../sync) carries it between peers.

> [!NOTE]
> In development and not yet published, with no public API yet. So far it has time in flicks, item ids, storyline position keys, layout (the storyline's start times, connected items' times and lanes), batches of operations in signed canonical bytes, and applying the operations on sequences, roles, assets and items to a document. [docs/architecture.md](docs/architecture.md) is the design.

## Licence

MIT.
