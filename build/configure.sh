#!/bin/sh
# SPDX-FileCopyrightText: 2026 The Snowy Authors
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# FFmpeg configure for one module (docs/architecture.md#modules). Usage: configure.sh MODULE
#   core       every single-file demuxer, all parsers, every native audio and subtitle decoder
#              except the long tail, and libswresample for float planar output
#   audio-ext  the long-tail audio decoders and libswresample
set -eu

# Decoders by section of libavcodec/allcodecs.c (native only: external libraries live in
# their own sections). New FFmpeg decoders are picked up without editing this file.
decoders_in() {
  awk -v want="$1" '
    /^\/\* .* \*\/$/ { section = $0 }
    /^extern const FFCodec ff_[a-z0-9_]+_decoder;/ && section ~ want {
      sub(/^extern const FFCodec ff_/, ""); sub(/_decoder;.*/, ""); printf "%s ", $0
    }' libavcodec/allcodecs.c
}

# Rare audio decoders, 30% of core's code: speech, game, legacy and niche lossless codecs.
# core opens their streams and returns AVERROR_DECODER_NOT_FOUND; audio-ext decodes them.
# Without the decoder, core's stream info for them is only what the demuxer and parser
# report: the sample format, for one, stays unknown until audio-ext decodes a frame.
# Moving a decoder between the modules is a change to this list only.
AUDIO_EXT="
  acelp_kelvin als apac aptx aptx_hd atrac1 atrac3 atrac3al atrac3p atrac3pal atrac9
  binkaudio_dct binkaudio_rdft bmv_audio bonk cook dfpwm dolby_e dsicinaudio dss_sp dst evrc
  fastaudio ffwavesynth ftr g723_1 g728 g729 gsm gsm_ms hca hcom iac ilbc imc interplay_acm
  mace3 mace6 metasound misc4 mp3adufloat mp3on4float mpc7 mpc8 msnsiren nellymoser on2avc
  osq paf_audio qcelp qdm2 qdmc qoa ra_144 ra_288 ralf sbc shorten sipr siren smackaud
  truespeech twinvq vmdaudio wavarc wmavoice ws_snd1 xma1 xma2
"

# Never built: decoders avcodec_find_decoder never picks, because one listed earlier in
# allcodecs.c decodes the same codec, and hdr, an image decoder filed under audio.
UNUSED="aac_fixed ac3_fixed mp1float mp2float mp3 mp3adu mp3on4 hdr"

# Demuxers that cannot work on one File: playlists and multi-file formats, network
# protocols, and ones that need external libraries we don't build.
EXCLUDED_DEMUXERS="
  hls dash concat imf dvdvideo
  image2 image2_alias_pix image2_brender_pix
  rtp rtsp sdp sap
  avisynth vapoursynth libgme libmodplug libopenmpt
"

# Words of $1 that are not in $2, comma-separated.
without() {
  for w in $1; do
    keep=1
    for x in $2; do
      if [ "$w" = "$x" ]; then keep=0; fi
    done
    if [ $keep = 1 ]; then printf "%s," "$w"; fi
  done
}

case "${1:-}" in
core)
  # comfortnoise is an audio decoder filed under video.
  decoders="$(without "$(decoders_in "audio codecs|PCM codecs|DPCM codecs|ADPCM codecs|subtitles") comfortnoise" "$AUDIO_EXT $UNUSED")"
  module="--enable-zlib --enable-bzlib --enable-demuxers --enable-parsers"
  module="$module --enable-bsf=extract_extradata,vp9_superframe_split"
  for d in $EXCLUDED_DEMUXERS; do module="$module --disable-demuxer=$d"; done
  ;;
audio-ext)
  # A misspelled name would only make FFmpeg's configure warn, and that decoder would be
  # built in neither module.
  unknown="$(without "$AUDIO_EXT" "$(decoders_in "audio codecs")")"
  if [ -n "$unknown" ]; then
    echo "AUDIO_EXT: not an audio decoder: ${unknown%,}" >&2
    exit 1
  fi
  decoders="$(without "$AUDIO_EXT" "")"
  module="--disable-avformat"
  ;;
*)
  echo "usage: configure.sh core|audio-ext" >&2
  exit 2
  ;;
esac

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
  --disable-avdevice --disable-avfilter --disable-swscale \
  --disable-iconv --disable-runtime-cpudetect \
  --enable-pthreads \
  $module \
  --enable-decoder="${decoders%,}"
