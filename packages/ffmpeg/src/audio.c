// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Audio frames and audio output: the API of every module that decodes audio.

#include "sny.h"

#include <libavutil/channel_layout.h>
#include <libavutil/downmix_info.h>
#include <libavutil/frame.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <string.h>

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

// ---- Resampling ----

// The output layouts: the Web Audio API's discrete speaker layouts, in its channel order.
static const AVChannelLayout LAYOUTS[] = {
    [1] = AV_CHANNEL_LAYOUT_MONO,
    [2] = AV_CHANNEL_LAYOUT_STEREO,
    [4] = AV_CHANNEL_LAYOUT_QUAD,
    [6] = AV_CHANNEL_LAYOUT_5POINT1,
};

// A resampler: libswresample's state, and the input and output it is set up for. The input
// layout is the frames' own, because swr_init replaces an unspecified one with the default
// layout, which then never equals the next frame's.
typedef struct SnyResampler {
  SwrContext *swr;
  AVChannelLayout layout;
  int format, rate, out_rate, out_channels;
  int has_mix;
  AVDownmixInfo mix;
} SnyResampler;

API SnyResampler *sny_resampler_alloc(void) {
  SnyResampler *r = av_mallocz(sizeof(*r));
  if (r && !(r->swr = swr_alloc()))
    av_freep(&r);
  return r;
}

API void sny_resampler_free(SnyResampler *r) {
  if (!r)
    return;
  swr_free(&r->swr);
  av_channel_layout_uninit(&r->layout);
  av_free(r);
}

// Drops the samples r holds back, for a seek: the next frame starts it afresh.
API void sny_resampler_flush(SnyResampler *r) { swr_close(r->swr); }

static const AVDownmixInfo *downmix_info(const AVFrame *in) {
  const AVFrameSideData *sd = av_frame_get_side_data(in, AV_FRAME_DATA_DOWNMIX_INFO);
  return sd ? (const AVDownmixInfo *)sd->data : NULL;
}

// Whether r is set up for frames like in, mixed to `channels` at `rate`. Changed downmix
// metadata counts, as it makes `ffmpeg` rebuild its filters.
static int set_up_for(const SnyResampler *r, const AVFrame *in, int rate, int channels) {
  const AVDownmixInfo *mix = downmix_info(in);
  return swr_is_initialized(r->swr) && in->format == r->format && in->sample_rate == r->rate &&
         !av_channel_layout_compare(&in->ch_layout, &r->layout) && rate == r->out_rate &&
         channels == r->out_channels && !!mix == r->has_mix &&
         (!mix || !memcmp(mix, &r->mix, sizeof(*mix)));
}

// The mix levels a stream's downmix metadata (AC-3, E-AC-3) asks for, else libswresample's
// defaults: what libavfilter's aresample, and so `ffmpeg -ac`, mixes with.
static void set_mix_levels(SwrContext *swr, const AVDownmixInfo *mix, int channels) {
  enum AVMatrixEncoding encoding = AV_MATRIX_ENCODING_NONE;
  // Dolby Surround compatible levels only for a downmix to stereo.
  if (mix && channels == 2 && mix->preferred_downmix_type == AV_DOWNMIX_TYPE_LTRT)
    encoding = AV_MATRIX_ENCODING_DOLBY;
  if (mix && channels == 2 && mix->preferred_downmix_type == AV_DOWNMIX_TYPE_DPLII)
    encoding = AV_MATRIX_ENCODING_DPLII;
  int ltrt = encoding != AV_MATRIX_ENCODING_NONE;
  av_opt_set_double(swr, "clev",
                    !mix   ? M_SQRT1_2
                    : ltrt ? mix->center_mix_level_ltrt
                           : mix->center_mix_level,
                    0);
  av_opt_set_double(swr, "slev",
                    !mix   ? M_SQRT1_2
                    : ltrt ? mix->surround_mix_level_ltrt
                           : mix->surround_mix_level,
                    0);
  av_opt_set_double(swr, "lfe_mix_level", mix ? mix->lfe_mix_level : 0, 0);
  av_opt_set_int(swr, "matrix_encoding", encoding, 0);
}

// Sets r up for frames like in, dropping any samples held back from the previous format.
static int configure(SnyResampler *r, const AVFrame *in, const AVFrame *out) {
  const AVDownmixInfo *mix = downmix_info(in);
  set_mix_levels(r->swr, mix, out->ch_layout.nb_channels);
  int ret = swr_config_frame(r->swr, out, in);
  if (ret >= 0)
    ret = swr_init(r->swr);
  if (ret >= 0)
    ret = av_channel_layout_copy(&r->layout, &in->ch_layout);
  if (ret < 0) {
    swr_close(r->swr);
    return ret;
  }

  r->format = in->format;
  r->rate = in->sample_rate;
  r->out_rate = out->sample_rate;
  r->out_channels = out->ch_layout.nb_channels;
  r->has_mix = !!mix;
  if (mix)
    r->mix = *mix;
  return 0;
}

// Makes out the samples of in at `rate` Hz on 1, 2, 4 or 6 `channels` (mono, stereo, quad,
// 5.1), as 32-bit float with the channels interleaved in the Web Audio API's order: what an
// AudioWorklet plays. Channels are mixed as `ffmpeg -ac` mixes them, with the stream's
// downmix levels. The resampler holds samples back between frames, so out may have none, and
// has no pts: its samples follow the previous output's. A null in, at the end of the stream,
// returns the samples held back. Returns 0 or a negative AVERROR.
API int sny_resample(SnyResampler *r, const AVFrame *in, AVFrame *out, int rate, int channels) {
  av_frame_unref(out);
  if (channels < 1 || channels >= (int)FF_ARRAY_ELEMS(LAYOUTS) || !LAYOUTS[channels].nb_channels)
    return AVERROR(EINVAL);
  out->format = AV_SAMPLE_FMT_FLT;
  out->sample_rate = rate;
  out->ch_layout = LAYOUTS[channels];
  int ret = in && !set_up_for(r, in, rate, channels) ? configure(r, in, out) : 0;
  if (ret < 0 || !swr_is_initialized(r->swr))
    return ret; // or the stream had no frame

  // Room for all the next conversion can return: swr_convert keeps the rest back.
  ret = swr_get_out_samples(r->swr, in ? in->nb_samples : 0);
  if (ret <= 0)
    return ret;
  out->nb_samples = ret;
  ret = av_frame_get_buffer(out, 0);
  if (ret < 0)
    return ret;
  const uint8_t **data = in ? (const uint8_t **)in->extended_data : NULL;
  ret = swr_convert(r->swr, out->extended_data, out->nb_samples, data, in ? in->nb_samples : 0);
  out->nb_samples = ret < 0 ? 0 : ret;
  return ret < 0 ? ret : 0;
}
