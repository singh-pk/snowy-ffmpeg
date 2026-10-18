---
name: ffmpeg-fix-format
description: Reproduce and fix a media file that fails to open, is missing streams, or has wrong timestamps or seeking in @snowy-media/ffmpeg. Use for issues labelled "format".
---

# Fix a format issue

Paths and commands are relative to `packages/ffmpeg/`.

1. **Get a sample.** Use the file from the issue. If there is none, ask for a 2-second cut (`ffmpeg -i in -t 2 -c copy sample.ext`) and stop.
2. **Ask native FFmpeg first.** Run `ffprobe -hide_banner -show_streams -show_packets sample.ext` with FFmpeg 9.0.2. Native output is the definition of correct.
   - Native fails too: it's an FFmpeg bug or a damaged file. Say so in the issue and link FFmpeg's tracker; do not patch FFmpeg here.
3. **Reproduce in the browser.** Add a line to `scripts/gen-fixtures.ts` that synthesises the same structure with native `ffmpeg` (the script recreates `test/fixtures/` from scratch, so files copied in by hand are lost), run `bun run fixtures`, then `bun test`. The failing test is the reproduction. If only the reporter's file shows the problem, debug with it locally and do not commit it unless its licence allows and a maintainer agrees.
4. **Classify the cause:**
   - **Demuxer or decoder not built:** check `build/configure.sh`. Network, playlist and multi-file demuxers are excluded on purpose; explain that rather than enabling them.
   - **I/O:** seeks past the end, short reads or `AVSEEK_SIZE` handling in `test/support/file-source.js` and `src/demux.c` `read_cb`/`seek_cb`.
   - **Probing:** `sny_set_probe_limits` too small for the file.
   - **API gap:** JavaScript needs a value the module doesn't export; use the `ffmpeg-add-api` skill.
5. **Fix, then prove it:** the new fixture passes in all three browsers, every other fixture still passes, and `bun run check` is clean. Keep fixtures under 100 KB.
