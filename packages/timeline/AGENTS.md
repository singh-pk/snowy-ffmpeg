# Agent guide: @snowy-media/timeline

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths below are relative to `packages/timeline/`.

This package is the edit document of the Snowy editor: a magnetic timeline of sequences, clips and anchors, the operations that change it, and the linear history every person and agent editing a project shares. It has no DOM, network, storage or media. Read [docs/architecture.md](docs/architecture.md) before changing it; code follows that design, and a change to the design changes that document in the same pull request.

## Rules

1. **Operations are the only way in.** Nothing changes the document except applying a batch of operations from the history or the pending batches.
2. **Applying is deterministic.** Never use a clock, random numbers, the locale or iteration order that differs between runs while applying entries; every peer must reach the same document.
3. **Append only.** Never rewrite or delete a batch or a removed item's state, and never rewrite an entry. The one exception is the design's: a new sequencer's term replaces entries its predecessor appended that it never received. Undo and revert are new batches.
4. **Positions are derived.** Never store a time that layout can work out from anchors and durations.
5. **Event-driven only.** No `setTimeout` or `setInterval`, and no polling. The package acts only when it is called.
6. **Pure.** No dependency on another Snowy package, and no browser-only API, so it runs in Bun.
