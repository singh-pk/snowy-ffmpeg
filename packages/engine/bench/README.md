# Benchmarks

`bun run bench` runs each benchmark in Chromium, Firefox and WebKit on a GPU, in a fresh browser per run, and prints the median of `--runs` runs in milliseconds. `--out bench/results/<name>.json` also writes the numbers, for a pull request that claims a change in speed.

| Benchmark | Measures |
| --- | --- |
| `startup` | `createEngine` until it resolves: the platform check, starting the render worker and opening a GPU device. `cold` is the first engine in a page, `warm` a second one with the worker script cached |

CI runs them on every engine change and shows the table in the job summary. Shared runners are noisy, so CI does not fail on a slowdown; compare numbers from one machine.

To add a benchmark, add an entry to `benchmarks` in [`run.ts`](run.ts) and a row here.
