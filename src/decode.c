// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Decoding, frames and audio output: the API of every module that decodes.

#include "sny.h"

#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libswresample/swresample.h>
#include <string.h>

// ---- Decoding ----

int sny_open_codec(const AVCodecParameters *par, AVRational time_base, AVCodecContext **out) {
  const AVCodec *codec = avcodec_find_decoder(par->codec_id);
  if (!codec)
    return AVERROR_DECODER_NOT_FOUND;
  AVCodecContext *dec = avcodec_alloc_context3(codec);
  if (!dec)
    return AVERROR(ENOMEM);
  int ret = avcodec_parameters_to_context(dec, par);
  if (ret >= 0) {
    dec->pkt_timebase = time_base;
    ret = avcodec_open2(dec, codec, NULL);
  }
  if (ret < 0) {
    avcodec_free_context(&dec);
    return ret;
  }
  *out = dec;
  return 0;
}

// Opens a decoder from the `size` bytes sny_params_export wrote in core, copied into this
// module. Returns 0 and stores the decoder in *out, or a negative AVERROR.
API int sny_decoder_open_params(const uint8_t *buf, int size, AVCodecContext **out) {
  SnyParams p;
  if (size < (int)sizeof p)
    return AVERROR(EINVAL);
  memcpy(&p, buf, sizeof p);
  int custom = p.par.ch_layout.order == AV_CHANNEL_ORDER_CUSTOM;
  if (p.par.ch_layout.nb_channels < 0 || p.par.extradata_size < 0)
    return AVERROR(EINVAL);
  size_t map = custom ? (size_t)p.par.ch_layout.nb_channels * sizeof(AVChannelCustom) : 0;
  if (sizeof p + map + (size_t)p.par.extradata_size != (size_t)size)
    return AVERROR(EINVAL);
  if (custom)
    p.par.ch_layout.u.map = (AVChannelCustom *)(buf + sizeof p);
  p.par.extradata = p.par.extradata_size ? (uint8_t *)buf + sizeof p + map : NULL;
  return sny_open_codec(&p.par, p.time_base, out);
}

API void sny_decoder_close(AVCodecContext *dec) { avcodec_free_context(&dec); }

// Sends a packet, or NULL (0) to drain at the end of the stream. AVERROR(EAGAIN) means
// the decoder is full: receive its frames, then send the packet again.
API int sny_decoder_send(AVCodecContext *dec, const AVPacket *pkt) {
  return avcodec_send_packet(dec, pkt);
}

// Receives the next frame into frame, releasing whatever frame held. AVERROR(EAGAIN) means
// send more packets; AVERROR_EOF means the decoder is drained.
API int sny_decoder_receive(AVCodecContext *dec, AVFrame *frame) {
  return avcodec_receive_frame(dec, frame);
}

// Drops buffered packets and frames; call after every seek.
API void sny_decoder_flush(AVCodecContext *dec) { avcodec_flush_buffers(dec); }

// ---- Frames ----

API AVFrame *sny_frame_alloc(void) { return av_frame_alloc(); }
API void sny_frame_free(AVFrame *frame) { av_frame_free(&frame); }
API int64_t sny_frame_pts(const AVFrame *frame) { return frame->pts; }
API int64_t sny_frame_duration(const AVFrame *frame) { return frame->duration; }
// An AVSampleFormat for audio.
API int sny_frame_format(const AVFrame *frame) { return frame->format; }

// audio
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
