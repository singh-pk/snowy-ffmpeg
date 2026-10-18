#!/bin/sh
# SPDX-FileCopyrightText: 2026 The Snowy Authors
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# FFmpeg configure for one module (docs/architecture.md#modules). Usage: configure.sh MODULE
#   core       every single-file demuxer, all parsers, every native audio and subtitle decoder
#              except the long tail, and libswresample for float planar output
#   audio-ext  the long-tail audio decoders and libswresample
#   video      the video decoders real files use, libdav1d for AV1, and libswscale
#   video-ext  every other video decoder, and libswscale
# configure.sh video-codecs prints the codec IDs of `video` as C, for core's codec table.
set -eu

# Native decoders whose codec is of media type $1 (AUDIO, VIDEO or SUBTITLE). The type comes
# from each decoder's codec ID (its FFCodec's `.p.id`) and codec_desc.c, not from the section
# of allcodecs.c it is listed in: some are misfiled (S302M and Speex audio under video, hdr
# images under audio). Decoders defined through macros (PCM, ADPCM, DPCM, DSD) count as their
# section's type; unread ones in the video section are hardware wrappers, never built.
# External libraries have their own sections and are left out. New FFmpeg decoders are
# picked up without editing this file.
decoders_of() {
  awk -v want="$1" '
    FILENAME ~ /\/codec_desc\.c$/ {
      if (match($0, /\.id *= *AV_CODEC_ID_[A-Z0-9_]+/)) { id = substr($0, RSTART, RLENGTH); sub(/.*AV_CODEC_ID_/, "", id) }
      if (match($0, /\.type *= *AVMEDIA_TYPE_[A-Z]+/)) { t = substr($0, RSTART, RLENGTH); sub(/.*AVMEDIA_TYPE_/, "", t); type[id] = t }
      next
    }
    FILENAME ~ /\/allcodecs\.c$/ {
      if (FNR == 1) section = "video codecs" # the first section has no heading
      if ($0 ~ /^\/\* [A-Za-z]/) section = $0
      if ($0 ~ /^extern const FFCodec ff_[a-z0-9_]+_decoder;/) {
        name = $0; sub(/^extern const FFCodec ff_/, "", name); sub(/_decoder;.*/, "", name)
        if (name in fallback) next # the glob below lists this file again
        if (section ~ /video codecs|text/) fallback[name] = "-"
        else if (section ~ /audio codecs|PCM codecs|DPCM codecs|ADPCM codecs/) fallback[name] = "AUDIO"
        else if (section ~ /subtitles/) fallback[name] = "SUBTITLE"
        else next
        order[++n] = name
      }
      next
    }
    /^const FFCodec ff_[a-z0-9_]+_decoder = \{/ { name = $0; sub(/^const FFCodec ff_/, "", name); sub(/_decoder.*/, "", name); open = 1 }
    open && match($0, /\.p\.id[ \t]*=[ \t]*AV_CODEC_ID_[A-Z0-9_]+/) {
      id = substr($0, RSTART, RLENGTH); sub(/.*AV_CODEC_ID_/, "", id); codec[name] = id; open = 0
    }
    open && /^};/ { open = 0 }
    END {
      for (i = 1; i <= n; i++) {
        name = order[i]
        t = (name in codec) ? type[codec[name]] : fallback[name]
        if (t == want) printf "%s ", name
      }
    }' libavcodec/codec_desc.c libavcodec/allcodecs.c libavcodec/*.c libavcodec/*/*.c
}

# The codec ID of each decoder in $1, as C enum values.
codec_ids() {
  for name in $1; do
    id="$(awk -v d="ff_${name}_decoder" '
      $0 ~ ("^const FFCodec " d " = \\{") { open = 1 }
      open && match($0, /\.p\.id[ \t]*=[ \t]*AV_CODEC_ID_[A-Z0-9_]+/) {
        s = substr($0, RSTART, RLENGTH); sub(/.*AV_CODEC_ID_/, "", s); print s; exit
      }
      open && /^};/ { exit }' libavcodec/*.c libavcodec/*/*.c)"
    if [ -z "$id" ]; then
      echo "no codec ID found for decoder $name" >&2
      exit 1
    fi
    echo "AV_CODEC_ID_$id,"
  done
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

# The video decoders real files use: camera, phone, web, broadcast, disc and editing codecs.
# Moving a decoder between video and video-ext is a change to this list only.
VIDEO="
  h264 hevc vp8 vp9 mpeg1video mpeg2video mpeg4 msmpeg4v1 msmpeg4v2 msmpeg4v3
  h263 h263i h263p flv vc1 wmv1 wmv2 wmv3 prores dnxhd mjpeg theora vp6 vp6a vp6f
  rv30 rv40 rawvideo ffv1
"

# Never built: decoders avcodec_find_decoder never picks, because one listed earlier in
# allcodecs.c decodes the same codec.
UNUSED="aac_fixed ac3_fixed mp1float mp2float mp3 mp3adu mp3on4 mpegvideo ass subrip"
# Nor GPL-only ones (their dependency, lgpl_gpl, comes with --enable-gpl): the modules are LGPL.
UNUSED="$UNUSED $(sed -n 's/^\([a-z0-9_]*\)_decoder_deps="lgpl_gpl"$/\1/p' configure)"

# Demuxers that cannot work on one File: playlists and multi-file formats, network
# protocols, and ones that need external libraries we don't build.
EXCLUDED_DEMUXERS="
  hls dash concat imf dvdvideo
  image2 image2_alias_pix image2_brender_pix
  rtp rtsp sdp sap
  avisynth vapoursynth libgme libmodplug libopenmpt
"

# Fails when a name in list $2 (called $1) is not among decoders $3. A misspelled name would
# only make FFmpeg's configure warn, and that decoder would be built in no module.
known() {
  unknown="$(without "$2" "$3")"
  if [ -n "$unknown" ]; then
    echo "$1: not a decoder here: ${unknown%,}" >&2
    exit 1
  fi
}

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
  decoders="$(without "$(decoders_of AUDIO) $(decoders_of SUBTITLE)" "$AUDIO_EXT $UNUSED")"
  module="--disable-swscale --enable-zlib --enable-bzlib --enable-demuxers --enable-parsers"
  module="$module --enable-bsf=extract_extradata,vp9_superframe_split"
  for d in $EXCLUDED_DEMUXERS; do module="$module --disable-demuxer=$d"; done
  ;;
audio-ext)
  known AUDIO_EXT "$AUDIO_EXT" "$(decoders_of AUDIO)"
  decoders="$(without "$AUDIO_EXT" "")"
  module="--disable-avformat --disable-swscale"
  ;;
video)
  known VIDEO "$VIDEO" "$(decoders_of VIDEO)"
  decoders="$(without "$VIDEO libdav1d" "")"
  module="--disable-avformat --enable-libdav1d"
  ;;
video-ext)
  decoders="$(without "$(decoders_of VIDEO)" "$VIDEO $UNUSED")"
  module="--disable-avformat --enable-zlib --enable-bzlib"
  ;;
video-codecs)
  known VIDEO "$VIDEO" "$(decoders_of VIDEO)"
  codec_ids "$VIDEO libdav1d"
  exit 0
  ;;
*)
  echo "usage: configure.sh core|audio-ext|video|video-ext|video-codecs" >&2
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
  --disable-avdevice --disable-avfilter \
  --disable-iconv --disable-runtime-cpudetect \
  --enable-pthreads \
  $module ${EXTRA_CONFIGURE:-} \
  --enable-decoder="${decoders%,}"
