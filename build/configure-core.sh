#!/bin/sh
# SPDX-FileCopyrightText: 2026 The Snowy Authors
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# FFmpeg configure for the `core` module (docs/architecture.md#modules).
# Every single-file demuxer, all parsers, and every native audio and subtitle decoder.
# The decoders belong here even for demuxing: avformat_find_stream_info needs them to fill
# in codec parameters (e.g. ADTS AAC has no packet timestamps without the AAC decoder).
set -eu

# Decoders by section of libavcodec/allcodecs.c (native only: external libraries live in
# their own sections). New FFmpeg decoders are picked up without editing this file.
decoders_in() {
  awk -v want="$1" '
    /^\/\* .* \*\/$/ { section = $0 }
    /^extern const FFCodec ff_[a-z0-9_]+_decoder;/ && section ~ want {
      sub(/^extern const FFCodec ff_/, ""); sub(/_decoder;.*/, ""); printf "%s,", $0
    }' libavcodec/allcodecs.c
}

DECODERS="$(decoders_in "audio codecs|PCM codecs|DPCM codecs|ADPCM codecs|subtitles")"

# Demuxers that cannot work on one File: playlists and multi-file formats, network
# protocols, and ones that need external libraries we don't build.
EXCLUDED_DEMUXERS="
  hls dash concat imf dvdvideo
  image2 image2_alias_pix image2_brender_pix
  rtp rtsp sdp sap
  avisynth vapoursynth libgme libmodplug libopenmpt
"

disable=""
for d in $EXCLUDED_DEMUXERS; do disable="$disable --disable-demuxer=$d"; done

# shellcheck disable=SC2086
emconfigure ./configure \
  --prefix="$SYSROOT" \
  --target-os=none --arch=wasm --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="$CFLAGS -I$SYSROOT/include" \
  --extra-ldflags="$LDFLAGS -L$SYSROOT/lib" \
  --disable-everything --disable-autodetect \
  --disable-programs --disable-doc --disable-debug --disable-stripping \
  --disable-network --disable-protocols \
  --disable-avdevice --disable-avfilter --disable-swresample --disable-swscale \
  --disable-iconv --disable-runtime-cpudetect \
  --enable-pthreads --enable-zlib --enable-bzlib \
  --enable-demuxers $disable \
  --enable-parsers \
  --enable-decoder="${DECODERS%,}" \
  --enable-bsf=extract_extradata,vp9_superframe_split
