# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 The Snowy Authors
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Every version and checksum lives here; nothing is fetched unpinned.
# Build: docker buildx build --target dist --output type=local,dest=dist .

# Link flags of every module, used only by the link stages so changing them only relinks.
ARG MODULE_LDFLAGS="-sENVIRONMENT=worker -sMODULARIZE -sEXPORT_ES6 \
  -sFILESYSTEM=0 -sASSERTIONS=0 -sDYNAMIC_EXECUTION=0 -sTEXTDECODER=2 \
  -sPTHREAD_POOL_SIZE=0 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF32,UTF8ToString,stringToNewUTF8"
# Video decoders create their threads while opening, which a WebAssembly worker can't wait
# for: the pool starts with the module, one thread per core up to 8, and asking a decoder
# for more fails instead of hanging.
ARG VIDEO_LDFLAGS="-sPTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency,8) \
  -sPTHREAD_POOL_SIZE_STRICT=2"
ARG EMSDK_IMAGE=emscripten/emsdk:6.0.12@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05

FROM ${EMSDK_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends xz-utils pkg-config gnupg \
 && rm -rf /var/lib/apt/lists/*
# One build configuration for every module: threads + SIMD + LTO (docs/architecture.md#build).
# OPT exists only so bench/variants.ts can A/B optimisation levels; releases use the default.
ARG OPT="-O3 -flto"
ENV SYSROOT=/opt/sysroot \
    CFLAGS="$OPT -msimd128 -pthread" \
    LDFLAGS="$OPT -msimd128 -pthread"

FROM base AS sources
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
# FFmpeg release signing key <ffmpeg-devel@ffmpeg.org>; public key in keys/ffmpeg-devel.asc
ARG FFMPEG_SIGNING_FINGERPRINT=FCF986EA15E6E293A5644F10B4322F04D67658D8
ARG DAV1D_VERSION=1.5.4
ARG DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
ARG ZLIB_VERSION=1.3.2
ARG ZLIB_SHA256=d7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3
ARG BZIP2_VERSION=1.0.8
ARG BZIP2_SHA256=ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269
WORKDIR /src
COPY keys/ffmpeg-devel.asc /keys/
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN set -eu; \
    fetch() { \
      curl -fsSL "$2" -o archive; \
      echo "$3  archive" | sha256sum -c -; \
      if [ -n "${4:-}" ]; then \
        curl -fsSL "$2.asc" -o archive.asc; \
        GNUPGHOME="$(mktemp -d)"; export GNUPGHOME; \
        gpg --batch -q --import /keys/ffmpeg-devel.asc; \
        gpg --batch --status-fd 1 --verify archive.asc archive | grep -q "VALIDSIG $4 "; \
        rm -rf "$GNUPGHOME" archive.asc; \
      fi; \
      mkdir "$1"; tar -xf archive --strip-components=1 -C "$1"; rm archive; \
    }; \
    fetch ffmpeg "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" "$FFMPEG_SHA256" "$FFMPEG_SIGNING_FINGERPRINT"; \
    fetch dav1d  "https://downloads.videolan.org/pub/videolan/dav1d/${DAV1D_VERSION}/dav1d-${DAV1D_VERSION}.tar.xz" "$DAV1D_SHA256"; \
    fetch zlib   "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.xz" "$ZLIB_SHA256"; \
    fetch bzip2  "https://sourceware.org/pub/bzip2/bzip2-${BZIP2_VERSION}.tar.gz" "$BZIP2_SHA256"

FROM base AS zlib
COPY --from=sources /src/zlib /src/zlib
WORKDIR /src/zlib
RUN emconfigure ./configure --prefix="$SYSROOT" --static \
 && emmake make -j"$(nproc)" install

FROM base AS bzip2
COPY --from=sources /src/bzip2 /src/bzip2
WORKDIR /src/bzip2
RUN emmake make libbz2.a CC=emcc AR=emar RANLIB=emranlib CFLAGS="$CFLAGS -D_FILE_OFFSET_BITS=64" \
 && install -Dm644 libbz2.a "$SYSROOT/lib/libbz2.a" \
 && install -Dm644 bzlib.h "$SYSROOT/include/bzlib.h"

# Ubuntu 24.04's release versions, which its archive keeps: meson sets dav1d's compile flags.
# Their Python dependencies are not pinned; dist.sha256 catches any change they make.
FROM base AS dav1d
RUN apt-get update \
 && apt-get install -y --no-install-recommends meson=1.3.2-1ubuntu1 ninja-build=1.11.1-2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=sources /src/dav1d /src/dav1d
WORKDIR /src/dav1d
# No dav1d assembly exists for WebAssembly; simd128 comes from the compiler.
RUN args="$(printf "'%s'," $CFLAGS)" \
 && printf "[binaries]\nc = 'emcc'\nar = 'emar'\n[built-in options]\nc_args = [%s]\nc_link_args = [%s]\n[host_machine]\nsystem = 'emscripten'\ncpu_family = 'wasm32'\ncpu = 'wasm32'\nendian = 'little'\n" "$args" "$args" > /tmp/cross.txt \
 && meson setup build --cross-file /tmp/cross.txt --prefix="$SYSROOT" --libdir=lib \
      --buildtype=release -Ddefault_library=static -Denable_asm=false \
      -Denable_tools=false -Denable_tests=false -Denable_examples=false \
 && ninja -C build install

FROM base AS ffmpeg-core
COPY --from=zlib /opt/sysroot /opt/sysroot
COPY --from=bzip2 /opt/sysroot /opt/sysroot
COPY --from=sources /src/ffmpeg /src/ffmpeg
COPY build/configure.sh /build/
WORKDIR /src/ffmpeg
RUN sh /build/configure.sh core && emmake make -j"$(nproc)" install

FROM base AS ffmpeg-audio-ext
COPY --from=sources /src/ffmpeg /src/ffmpeg
COPY build/configure.sh /build/
WORKDIR /src/ffmpeg
RUN sh /build/configure.sh audio-ext && emmake make -j"$(nproc)" install

FROM base AS ffmpeg-video
COPY --from=dav1d /opt/sysroot /opt/sysroot
COPY --from=sources /src/ffmpeg /src/ffmpeg
COPY build/configure.sh /build/
WORKDIR /src/ffmpeg
# Extra configure flags for a benchmark variant of this module (bench/variants.ts).
ARG EXTRA_CONFIGURE=""
RUN EM_PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig" sh /build/configure.sh video \
 && emmake make -j"$(nproc)" install

FROM base AS ffmpeg-video-ext
COPY --from=zlib /opt/sysroot /opt/sysroot
COPY --from=bzip2 /opt/sysroot /opt/sysroot
COPY --from=sources /src/ffmpeg /src/ffmpeg
COPY build/configure.sh /build/
WORKDIR /src/ffmpeg
RUN sh /build/configure.sh video-ext && emmake make -j"$(nproc)" install

# Link flags are benchmarked (bench/README.md). EXTRA_LDFLAGS is for
# bench/variants.ts only. The API files of each module are listed in src/sny.h.
FROM ffmpeg-core AS core
COPY src /build/src
ARG MODULE_LDFLAGS
ARG EXTRA_LDFLAGS=""
RUN sh /build/configure.sh video-codecs > /build/src/video_codecs.h \
 && mkdir -p /out/core && emcc $CFLAGS $LDFLAGS $EXTRA_LDFLAGS $MODULE_LDFLAGS \
      /build/src/common.c /build/src/demux.c /build/src/decode.c /build/src/audio.c \
      -I"$SYSROOT/include" -L"$SYSROOT/lib" \
      -lavformat -lavcodec -lswresample -lavutil -lz -lbz2 \
      --js-library /build/src/io.js -sEXPORT_NAME=createCore \
      -o /out/core/core.js \
 && ls -l /out/core

FROM ffmpeg-audio-ext AS audio-ext
COPY src /build/src
ARG MODULE_LDFLAGS
ARG EXTRA_LDFLAGS=""
RUN mkdir -p /out/audio-ext && emcc $CFLAGS $LDFLAGS $EXTRA_LDFLAGS $MODULE_LDFLAGS \
      /build/src/common.c /build/src/decode.c /build/src/audio.c \
      -I"$SYSROOT/include" -L"$SYSROOT/lib" \
      -lavcodec -lswresample -lavutil -sEXPORT_NAME=createAudioExt \
      -o /out/audio-ext/audio-ext.js \
 && ls -l /out/audio-ext

FROM ffmpeg-video AS video
COPY src /build/src
ARG MODULE_LDFLAGS
ARG VIDEO_LDFLAGS
ARG EXTRA_LDFLAGS=""
RUN mkdir -p /out/video && emcc $CFLAGS $LDFLAGS $EXTRA_LDFLAGS $MODULE_LDFLAGS $VIDEO_LDFLAGS \
      /build/src/common.c /build/src/decode.c /build/src/video.c \
      -I"$SYSROOT/include" -L"$SYSROOT/lib" \
      -lavcodec -lswscale -lavutil -ldav1d -sEXPORT_NAME=createVideo \
      -o /out/video/video.js \
 && ls -l /out/video

FROM ffmpeg-video-ext AS video-ext
COPY src /build/src
ARG MODULE_LDFLAGS
ARG VIDEO_LDFLAGS
ARG EXTRA_LDFLAGS=""
RUN mkdir -p /out/video-ext && emcc $CFLAGS $LDFLAGS $EXTRA_LDFLAGS $MODULE_LDFLAGS $VIDEO_LDFLAGS \
      /build/src/common.c /build/src/decode.c /build/src/video.c \
      -I"$SYSROOT/include" -L"$SYSROOT/lib" \
      -lavcodec -lswscale -lavutil -lz -lbz2 -sEXPORT_NAME=createVideoExt \
      -o /out/video-ext/video-ext.js \
 && ls -l /out/video-ext

FROM scratch AS dist
COPY --from=core /out /
COPY --from=audio-ext /out /
COPY --from=video /out /
COPY --from=video-ext /out /
# The licences of the code in the modules, as their sources ship them (NOTICE).
COPY --from=sources /src/ffmpeg/COPYING.LGPLv2.1 /src/ffmpeg/LICENSE.md /licenses/ffmpeg/
COPY --from=sources /src/dav1d/COPYING /licenses/dav1d/
COPY --from=sources /src/zlib/LICENSE /licenses/zlib/
COPY --from=sources /src/bzip2/LICENSE /licenses/bzip2/

# The third-party sources as the build uses them, unmodified: half of each release's source
# archive (scripts/release.ts), which the LGPL requires next to the modules.
FROM scratch AS source
COPY --from=sources /src /
