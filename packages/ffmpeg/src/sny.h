// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Shared by the API files of every module. scripts/gen-dts.ts turns every `API` function and
// `SNY_CONST*` in a module's files into its index.js + index.d.ts:
//   core       common.c demux.c decode.c audio.c
//   audio-ext  common.c decode.c audio.c
//   video      common.c decode.c video.c
//   video-ext  common.c decode.c video.c
//
// Rules (docs/architecture.md): JS never computes an offset into an FFmpeg struct. Every
// field is a one-line getter, so FFmpeg upgrades either compile or fail loudly. Wrappers
// inline away under LTO.

#ifndef SNY_H
#define SNY_H

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>

#define API EMSCRIPTEN_KEEPALIVE

// Constants mirrored into TS. The compiler checks every value, so the TS copy can't drift.
#define SNY_CONST(name, value) _Static_assert((name) == (value), #name);
#define SNY_CONST64(name, value) _Static_assert((name) == (value), #name);

// A stream's codec parameters and time base as one block of bytes, so JavaScript can copy
// them from core's memory into another module's (sny_params_export, sny_decoder_open_params).
// Every module is built from the same headers, so the layout matches. Pointers are cleared;
// a custom channel map (its opaque fields keep core's values; no decoder reads them), the
// extradata, and then par.nb_coded_side_data entries of coded side data (HDR metadata, a
// display matrix, Dolby Vision configuration), each a SnySideData and its bytes, follow the
// struct.
typedef struct SnyParams {
  AVCodecParameters par;
  AVRational time_base;
} SnyParams;

typedef struct SnySideData {
  int type; // enum AVPacketSideDataType
  int size;
} SnySideData;

// Opens a decoder for par on up to `threads` threads; frame timestamps are in time_base.
// src/decode.c.
int sny_open_codec(const AVCodecParameters *par, AVRational time_base, int threads,
                   AVCodecContext **out);

#endif
