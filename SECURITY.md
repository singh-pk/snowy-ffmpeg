# Security policy

Snowy runs FFmpeg's parsers on untrusted files inside the browser's WebAssembly sandbox. Memory bugs in FFmpeg cannot escape that sandbox, but they can still crash a page, hang it, or corrupt what it shows or saves.

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/singh-pk/snowy-media/security/advisories/new). Do not open a public issue. Include the file or steps that trigger it and the browser you used. You will get an answer within 7 days.

What to report here:

- a file that crashes, hangs or exhausts memory in a module, or makes it read or write outside its own buffers;
- a weakness in how the build fetches or verifies sources, or in the CI workflows.

A bug in FFmpeg itself that also affects native FFmpeg belongs [upstream](https://ffmpeg.org/security.html) as well; we will help coordinate and ship the fix once it lands.

## Supported versions

Until 1.0, only the latest release gets fixes.
