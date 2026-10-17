## What and why

<!-- What changes, and the problem it solves. Link the issue: "Fixes #123". -->

## How it was verified

<!-- Commands you ran and what they showed. For performance changes, `bun run bench` before and after. -->

## Checklist

- [ ] The title is a Conventional Commit, e.g. `fix(core): keep pts when seeking raw H.264`
- [ ] `bun run check` and `bun test` pass
- [ ] Behaviour changes have a test; demuxing fixes have a fixture from native `ffprobe`
- [ ] `dist.sha256` is updated if the build output changed
- [ ] `CHANGELOG.md` is updated for user-visible changes
- [ ] Parts written by an AI agent are noted, and I have reviewed every line
