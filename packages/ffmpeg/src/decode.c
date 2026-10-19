// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Decoding and frames: the API of every module that decodes.

#include "sny.h"

#include <libavutil/frame.h>
#include <string.h>

// ---- Decoding ----

int sny_open_codec(const AVCodecParameters *par, AVRational time_base, int threads,
                   AVCodecContext **out) {
  const AVCodec *codec = avcodec_find_decoder(par->codec_id);
  if (!codec)
    return AVERROR_DECODER_NOT_FOUND;
  AVCodecContext *dec = avcodec_alloc_context3(codec);
  if (!dec)
    return AVERROR(ENOMEM);
  int ret = avcodec_parameters_to_context(dec, par);
  if (ret >= 0) {
    dec->pkt_timebase = time_base;
    dec->thread_count = threads;
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
// module, decoding on `threads` threads: 1 for audio; for video at least 1 (FFmpeg's automatic
// 0 asks for more than the pool) and, with every other decoder open in the module, at most its
// thread pool, or opening fails. Returns 0 and stores the decoder in *out, or a negative AVERROR.
API int sny_decoder_open_params(const uint8_t *buf, int size, int threads, AVCodecContext **out) {
  SnyParams p;
  if (threads < 1 || size < (int)sizeof p)
    return AVERROR(EINVAL);
  memcpy(&p, buf, sizeof p);
  int custom = p.par.ch_layout.order == AV_CHANNEL_ORDER_CUSTOM;
  int nb_side_data = p.par.nb_coded_side_data;
  if (p.par.ch_layout.nb_channels < 0 || p.par.extradata_size < 0 || nb_side_data < 0)
    return AVERROR(EINVAL);
  uint64_t map = custom ? (uint64_t)p.par.ch_layout.nb_channels * sizeof(AVChannelCustom) : 0;
  uint64_t at = sizeof p + map + (uint64_t)p.par.extradata_size;
  if (at > (uint64_t)size)
    return AVERROR(EINVAL);
  if (custom)
    p.par.ch_layout.u.map = (AVChannelCustom *)(buf + sizeof p);
  p.par.extradata = p.par.extradata_size ? (uint8_t *)buf + sizeof p + map : NULL;

  // The side data is rebuilt as FFmpeg allocates it; the decoder copies it while opening.
  p.par.coded_side_data = NULL;
  p.par.nb_coded_side_data = 0;
  int ret = 0;
  for (int i = 0; i < nb_side_data && ret >= 0; i++) {
    SnySideData h;
    if (at + sizeof h > (uint64_t)size) {
      ret = AVERROR(EINVAL);
      break;
    }
    memcpy(&h, buf + at, sizeof h);
    at += sizeof h;
    if (h.size < 0 || at + (uint64_t)h.size > (uint64_t)size) {
      ret = AVERROR(EINVAL);
      break;
    }
    AVPacketSideData *sd = av_packet_side_data_new(&p.par.coded_side_data,
                                                   &p.par.nb_coded_side_data, h.type, h.size, 0);
    if (!sd)
      ret = AVERROR(ENOMEM);
    else
      memcpy(sd->data, buf + at, h.size);
    at += h.size;
  }
  if (ret >= 0 && at != (uint64_t)size)
    ret = AVERROR(EINVAL);
  if (ret >= 0)
    ret = sny_open_codec(&p.par, p.time_base, threads, out);
  av_packet_side_data_free(&p.par.coded_side_data, &p.par.nb_coded_side_data);
  return ret;
}

API void sny_decoder_close(AVCodecContext *dec) { avcodec_free_context(&dec); }

// Sends a packet, or NULL (0) to drain at the end of the stream. AVERROR(EAGAIN) means
// the decoder is full: receive its frames, then send the packet again. A subtitle decoder
// returns AVERROR(EINVAL): FFmpeg does not check the media type here and would call its
// decode callback with an AVFrame where it expects an AVSubtitle, corrupting the frame.
API int sny_decoder_send(AVCodecContext *dec, const AVPacket *pkt) {
  if (dec->codec_type == AVMEDIA_TYPE_SUBTITLE)
    return AVERROR(EINVAL);
  return avcodec_send_packet(dec, pkt);
}

// Receives the next frame into frame, releasing whatever frame held. AVERROR(EAGAIN) means
// send more packets; AVERROR_EOF means the decoder is drained. A subtitle decoder returns
// AVERROR(EINVAL), as in sny_decoder_send.
API int sny_decoder_receive(AVCodecContext *dec, AVFrame *frame) {
  if (dec->codec_type == AVMEDIA_TYPE_SUBTITLE)
    return AVERROR(EINVAL);
  return avcodec_receive_frame(dec, frame);
}

// Drops buffered packets and frames; call after every seek.
API void sny_decoder_flush(AVCodecContext *dec) { avcodec_flush_buffers(dec); }

// ---- Frames ----

API AVFrame *sny_frame_alloc(void) { return av_frame_alloc(); }
API void sny_frame_free(AVFrame *frame) { av_frame_free(&frame); }
API int64_t sny_frame_pts(const AVFrame *frame) { return frame->pts; }
API int64_t sny_frame_duration(const AVFrame *frame) { return frame->duration; }
// An AVSampleFormat for audio, an AVPixelFormat for video.
API int sny_frame_format(const AVFrame *frame) { return frame->format; }
