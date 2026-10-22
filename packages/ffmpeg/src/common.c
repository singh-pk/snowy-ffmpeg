// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The API every module shares: constants, packets and utilities.

#include "sny.h"

#include <libavutil/error.h>
#include <libavutil/mathematics.h>
#include <libavutil/pixdesc.h>

SNY_CONST(AVERROR_EOF, -541478725)
SNY_CONST(AVERROR(EAGAIN), -6)
SNY_CONST(AVERROR(EINVAL), -28)
SNY_CONST(AVERROR(EIO), -29)
SNY_CONST(AVERROR_DECODER_NOT_FOUND, -1128613112)
SNY_CONST64(AV_NOPTS_VALUE, INT64_MIN)
SNY_CONST(AV_TIME_BASE, 1000000)
SNY_CONST(AV_PKT_FLAG_KEY, 1)
SNY_CONST(AV_PKT_FLAG_CORRUPT, 2)
SNY_CONST(AV_PKT_FLAG_DISCARD, 4)
SNY_CONST(AVMEDIA_TYPE_VIDEO, 0)
SNY_CONST(AVMEDIA_TYPE_AUDIO, 1)
SNY_CONST(AVMEDIA_TYPE_DATA, 2)
SNY_CONST(AVMEDIA_TYPE_SUBTITLE, 3)
SNY_CONST(AVMEDIA_TYPE_ATTACHMENT, 4)
// Colour: the values are those of ITU-T H.273, which codec strings use too.
SNY_CONST(AVCOL_RANGE_UNSPECIFIED, 0)
SNY_CONST(AVCOL_RANGE_MPEG, 1)
SNY_CONST(AVCOL_RANGE_JPEG, 2)
SNY_CONST(AVCOL_PRI_BT709, 1)
SNY_CONST(AVCOL_PRI_UNSPECIFIED, 2)
SNY_CONST(AVCOL_PRI_BT470BG, 5)
SNY_CONST(AVCOL_PRI_SMPTE170M, 6)
SNY_CONST(AVCOL_PRI_BT2020, 9)
SNY_CONST(AVCOL_PRI_SMPTE431, 11)
SNY_CONST(AVCOL_PRI_SMPTE432, 12)
SNY_CONST(AVCOL_TRC_BT709, 1)
SNY_CONST(AVCOL_TRC_UNSPECIFIED, 2)
SNY_CONST(AVCOL_TRC_SMPTE170M, 6)
SNY_CONST(AVCOL_TRC_LINEAR, 8)
SNY_CONST(AVCOL_TRC_IEC61966_2_1, 13)
SNY_CONST(AVCOL_TRC_BT2020_10, 14)
SNY_CONST(AVCOL_TRC_BT2020_12, 15)
SNY_CONST(AVCOL_TRC_SMPTE2084, 16)
SNY_CONST(AVCOL_TRC_ARIB_STD_B67, 18)
SNY_CONST(AVCOL_SPC_RGB, 0)
SNY_CONST(AVCOL_SPC_BT709, 1)
SNY_CONST(AVCOL_SPC_UNSPECIFIED, 2)
SNY_CONST(AVCOL_SPC_BT470BG, 5)
SNY_CONST(AVCOL_SPC_SMPTE170M, 6)
SNY_CONST(AVCOL_SPC_BT2020_NCL, 9)
SNY_CONST(AVCHROMA_LOC_UNSPECIFIED, 0)
SNY_CONST(AVCHROMA_LOC_LEFT, 1)
SNY_CONST(AVCHROMA_LOC_CENTER, 2)
SNY_CONST(AVCHROMA_LOC_TOPLEFT, 3)

// ---- Packets ----

API AVPacket *sny_packet_alloc(void) { return av_packet_alloc(); }
API void sny_packet_free(AVPacket *pkt) { av_packet_free(&pkt); }

API int sny_packet_stream(const AVPacket *pkt) { return pkt->stream_index; }
API int64_t sny_packet_pts(const AVPacket *pkt) { return pkt->pts; }
API int64_t sny_packet_dts(const AVPacket *pkt) { return pkt->dts; }
API int64_t sny_packet_duration(const AVPacket *pkt) { return pkt->duration; }
API int64_t sny_packet_pos(const AVPacket *pkt) { return pkt->pos; }
API int sny_packet_flags(const AVPacket *pkt) { return pkt->flags; }
API uint8_t *sny_packet_data(const AVPacket *pkt) { return pkt->data; }
API int sny_packet_size(const AVPacket *pkt) { return pkt->size; }
// Moves src's data, side data and timestamps into dst, freeing what dst held, and leaves src
// blank: a packet is queued without copying or allocating.
API void sny_packet_move(AVPacket *dst, AVPacket *src) {
  av_packet_unref(dst);
  av_packet_move_ref(dst, src);
}

// Makes pkt a new packet of `size` bytes with these timestamps and flags, and returns its
// data for JavaScript to fill, or NULL when out of memory. This is how a packet core
// demuxed reaches a decoder in another module.
API uint8_t *sny_packet_make(AVPacket *pkt, int size, int64_t pts, int64_t dts, int64_t duration,
                             int flags) {
  av_packet_unref(pkt);
  if (av_new_packet(pkt, size) < 0)
    return NULL;
  pkt->pts = pts;
  pkt->dts = dts;
  pkt->duration = duration;
  pkt->flags = flags;
  return pkt->data;
}

// Side data (skip samples from an edit list, for one), copied across the same way.
API int sny_packet_side_data_count(const AVPacket *pkt) { return pkt->side_data_elems; }
API int sny_packet_side_data_type(const AVPacket *pkt, int i) { return pkt->side_data[i].type; }
API uint8_t *sny_packet_side_data(const AVPacket *pkt, int i) { return pkt->side_data[i].data; }
API int sny_packet_side_data_size(const AVPacket *pkt, int i) { return pkt->side_data[i].size; }
// Adds side data of `type` and `size` bytes to pkt and returns it for JavaScript to fill, or
// NULL when out of memory.
API uint8_t *sny_packet_side_data_add(AVPacket *pkt, int type, int size) {
  return av_packet_new_side_data(pkt, type, size);
}

// ---- Pixel formats and colour ----

// FFmpeg's names, as ffprobe prints them, or NULL for a value FFmpeg does not know.
API const char *sny_pix_fmt_name(int fmt) { return av_get_pix_fmt_name(fmt); }
API const char *sny_color_range_name(int v) { return av_color_range_name(v); }
API const char *sny_color_primaries_name(int v) { return av_color_primaries_name(v); }
API const char *sny_color_trc_name(int v) { return av_color_transfer_name(v); }
API const char *sny_color_space_name(int v) { return av_color_space_name(v); }
API const char *sny_chroma_location_name(int v) { return av_chroma_location_name(v); }

// Bits per sample of a pixel format's first component, and the log2 of its chroma
// subsampling across and down; 0 for a format FFmpeg does not know.
API int sny_pix_fmt_depth(int fmt) {
  const AVPixFmtDescriptor *d = av_pix_fmt_desc_get(fmt);
  return d ? d->comp[0].depth : 0;
}
API int sny_pix_fmt_log2_chroma_w(int fmt) {
  const AVPixFmtDescriptor *d = av_pix_fmt_desc_get(fmt);
  return d ? d->log2_chroma_w : 0;
}
API int sny_pix_fmt_log2_chroma_h(int fmt) {
  const AVPixFmtDescriptor *d = av_pix_fmt_desc_get(fmt);
  return d ? d->log2_chroma_h : 0;
}

// ---- Utilities ----

// Exact time-base conversion (round to nearest); AV_NOPTS_VALUE passes through.
API int64_t sny_rescale(int64_t ts, int from_num, int from_den, int to_num, int to_den) {
  if (ts == AV_NOPTS_VALUE)
    return ts;
  return av_rescale_q_rnd(ts, (AVRational){from_num, from_den}, (AVRational){to_num, to_den},
                          AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX);
}

// AV_LOG_* level (e.g. 16 = error, 24 = warning, 32 = info). Logs go to the console.
API void sny_set_log_level(int level) { av_log_set_level(level); }

API const char *sny_strerror(int err) {
  static char buf[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(err, buf, sizeof buf);
  return buf;
}
