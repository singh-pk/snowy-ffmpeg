// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Audio frames and audio output: the API of every module that decodes audio.

#include "sny.h"

#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libswresample/swresample.h>

// ---- Audio frames ----

API int sny_frame_samples(const AVFrame *frame) { return frame->nb_samples; }
API int sny_frame_sample_rate(const AVFrame *frame) { return frame->sample_rate; }
API int sny_frame_channels(const AVFrame *frame) { return frame->ch_layout.nb_channels; }
// The AVChannel (speaker position) of channel i, e.g. 3 = low-frequency effects.
API int sny_frame_channel(const AVFrame *frame, int i) {
  return av_channel_layout_channel_from_index(&frame->ch_layout, i);
}
// Plane i: channel i of planar audio. extended_data, because audio can have more than
// AV_NUM_DATA_POINTERS channels.
API uint8_t *sny_frame_plane(const AVFrame *frame, int i) { return frame->extended_data[i]; }

// ---- Audio output ----

// JavaScript always gets audio as 32-bit float planar: per channel, one plane of
// nb_samples floats. A converter holds the libswresample state between frames.
API SwrContext *sny_converter_alloc(void) { return swr_alloc(); }
API void sny_converter_free(SwrContext *swr) { swr_free(&swr); }

static int convert(SwrContext *swr, const AVFrame *in, AVFrame *out) {
  av_frame_unref(out);
  out->format = AV_SAMPLE_FMT_FLTP;
  out->sample_rate = in->sample_rate;
  int ret = av_channel_layout_copy(&out->ch_layout, &in->ch_layout);
  return ret < 0 ? ret : swr_convert_frame(swr, out, in);
}

// Makes out the float planar copy of in: same samples, rate and channels, no resampling,
// so the values are exactly what native FFmpeg produces. A frame that is already float
// planar (AAC, Opus, AC-3, Vorbis, MP3) is referenced, not copied. Returns 0 or a
// negative AVERROR.
API int sny_to_float_planar(SwrContext *swr, const AVFrame *in, AVFrame *out) {
  if (in->format == AV_SAMPLE_FMT_FLTP) {
    av_frame_unref(out);
    return av_frame_ref(out, in);
  }

  int ret = convert(swr, in, out);
  if (ret == AVERROR_INPUT_CHANGED || ret == AVERROR_OUTPUT_CHANGED) {
    swr_close(swr); // the stream changed format mid-way: reconfigure from this frame
    ret = convert(swr, in, out);
  }
  return ret < 0 ? ret : av_frame_copy_props(out, in);
}
