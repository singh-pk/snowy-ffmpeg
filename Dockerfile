# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 The Snowy Authors
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Every version and checksum lives here; nothing is fetched unpinned.
# Build: docker buildx build --target dist --output type=local,dest=dist .

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

FROM base AS ffmpeg-core
COPY --from=zlib /opt/sysroot /opt/sysroot
COPY --from=bzip2 /opt/sysroot /opt/sysroot
COPY --from=sources /src/ffmpeg /src/ffmpeg
COPY build/configure-core.sh /build/
WORKDIR /src/ffmpeg
RUN sh /build/configure-core.sh && emmake make -j"$(nproc)" install

FROM ffmpeg-core AS core
COPY src /build/src
# Link flags are benchmarked (bench/README.md). EXTRA_LDFLAGS is for
# bench/variants.ts only.
ARG EXTRA_LDFLAGS=""
RUN mkdir -p /out/core && emcc $CFLAGS $LDFLAGS $EXTRA_LDFLAGS \
      /build/src/helpers.c -I"$SYSROOT/include" -L"$SYSROOT/lib" \
      -lavformat -lavcodec -lswresample -lavutil -lz -lbz2 \
      --js-library /build/src/io.js \
      -sENVIRONMENT=worker -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createCore \
      -sFILESYSTEM=0 -sASSERTIONS=0 -sDYNAMIC_EXECUTION=0 -sTEXTDECODER=2 \
      -sPTHREAD_POOL_SIZE=0 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB \
      -sEXPORTED_FUNCTIONS=_malloc,_free \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF32,UTF8ToString,stringToNewUTF8 \
      -o /out/core/core.js \
 && ls -l /out/core

FROM scratch AS dist
COPY --from=core /out /
