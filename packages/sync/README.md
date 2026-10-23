<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/singh-pk/snowy-media/main/brand/mark-dark.svg">
  <img src="https://raw.githubusercontent.com/singh-pk/snowy-media/main/brand/mark.svg" alt="Snowy" height="48">
</picture>

# @snowy-media/sync

[![ci](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/singh-pk/snowy-media/blob/main/LICENSE)

Watch-together sessions for [Snowy](https://github.com/singh-pk/snowy-media): one person plays a local file to a group of viewers, everyone shares a chat, and each viewer picks their own audio and subtitle tracks. Media goes once from the source to a stateless [MoQ](https://datatracker.ietf.org/wg/moq/about/) relay over WebTransport, and is shared onwards through WebRTC peer groups. Every peer keeps its own copy, so playback and chat carry on through a dropped connection. It plays through [`@snowy-media/engine`](../engine).

> [!NOTE]
> In design and not yet published. There is no code yet; [docs/architecture.md](docs/architecture.md) is the design.

## Requirements

A page served with cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`) in desktop Chromium, as `@snowy-media/engine` needs, which also has WebTransport, WebRTC data channels, the Origin Private File System, and Ed25519 in Web Crypto. A session needs a MoQ relay and two STUN endpoints; nothing else runs on a server.

## Licence

MIT.
