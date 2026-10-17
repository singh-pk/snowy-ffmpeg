---
name: benchmark
description: Measure the speed or size effect of a change with bench/run.ts and report it honestly. Use for any change that can affect performance or module size, and before claiming a speed-up.
---

# Benchmark a change

1. **Media:** `bun scripts/gen-bench-media.ts` once (about 3 GB in `bench/media`, gitignored).
2. **Baseline first.** On the base commit: `bun run build && bun run bench --libs snowy --runs 5 --out bench/results/before.json`. Close other heavy apps; on laptops, stay on power.
3. **After:** the same command on your change with `--out bench/results/after.json`.
4. **Compare** demux ms, open ms, warm seek ms and brotli size per container and browser. Differences under ~5% are noise on one machine; repeat with more runs before trusting them.
5. **Build-flag ideas** go through `bun bench/variants.ts <name>` with a new entry in its `VARIANTS` table, not by editing the release flags first.
6. **Report** a small table in the pull request with the machine, browser versions and both numbers. Commit result JSON only when it updates the published numbers in `bench/README.md`; delete scratch files.

Never present one run, or numbers from different machines, as a result.
