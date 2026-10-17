// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The whole JS boundary of the core module, and the single source of truth for it:
// scripts/gen-dts.ts turns every `API` function and `SNY_CONST*` below into index.js + index.d.ts.
//
// Rules (docs/architecture.md): JS never computes an offset into an FFmpeg struct. Every
// field is a one-line getter here, so FFmpeg upgrades either compile or fail loudly.
// Wrappers inline away under LTO.

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/mathematics.h>

#define API EMSCRIPTEN_KEEPALIVE

// Constants mirrored into TS. The compiler checks every value, so the TS copy can't drift.
#define SNY_CONST(name, value) _Static_assert((name) == (value), #name);
#define SNY_CONST64(name, value) _Static_assert((name) == (value), #name);

SNY_CONST(AVERROR_EOF, -541478725)
SNY_CONST(AVERROR(EAGAIN), -6)
SNY_CONST(AVERROR(EIO), -29)
SNY_CONST64(AV_NOPTS_VALUE, INT64_MIN)
SNY_CONST(AV_TIME_BASE, 1000000)
SNY_CONST(AVSEEK_SIZE, 0x10000)
SNY_CONST(AVSEEK_FORCE, 0x20000)
SNY_CONST(AVSEEK_FLAG_BACKWARD, 1)
SNY_CONST(AVSEEK_FLAG_BYTE, 2)
SNY_CONST(AVSEEK_FLAG_ANY, 4)
SNY_CONST(AV_PKT_FLAG_KEY, 1)
SNY_CONST(AV_PKT_FLAG_CORRUPT, 2)
SNY_CONST(AV_PKT_FLAG_DISCARD, 4)
SNY_CONST(AVINDEX_KEYFRAME, 1)
SNY_CONST(AVMEDIA_TYPE_VIDEO, 0)
SNY_CONST(AVMEDIA_TYPE_AUDIO, 1)
SNY_CONST(AVMEDIA_TYPE_DATA, 2)
SNY_CONST(AVMEDIA_TYPE_SUBTITLE, 3)
SNY_CONST(AVMEDIA_TYPE_ATTACHMENT, 4)

// ---- I/O: implemented in src/io.js, called by FFmpeg through AVIO ----

extern int sny_io_read(int io, uint8_t *buf, int size);
extern int64_t sny_io_seek(int io, int64_t offset, int whence);

static int read_cb(void *opaque, uint8_t *buf, int size) {
  int n = sny_io_read((int)(intptr_t)opaque, buf, size);
  return n == 0 ? AVERROR_EOF : n;
}

static int64_t seek_cb(void *opaque, int64_t offset, int whence) {
  return sny_io_seek((int)(intptr_t)opaque, offset, whence & ~AVSEEK_FORCE);
}

// ---- Open / close ----

// Opens input `io` (an id the JS hooks understand) with an AVIO buffer of `buffer_size`
// bytes. Returns 0 and stores the context in *out, or a negative AVERROR.
API int sny_open(int io, int buffer_size, AVFormatContext **out) {
  uint8_t *buf = av_malloc(buffer_size);
  if (!buf)
    return AVERROR(ENOMEM);
  AVIOContext *pb =
      avio_alloc_context(buf, buffer_size, 0, (void *)(intptr_t)io, read_cb, NULL, seek_cb);
  if (!pb) {
    av_free(buf);
    return AVERROR(ENOMEM);
  }
  AVFormatContext *ctx = avformat_alloc_context();
  if (!ctx) {
    av_freep(&pb->buffer);
    avio_context_free(&pb);
    return AVERROR(ENOMEM);
  }
  ctx->pb = pb;
  ctx->flags |= AVFMT_FLAG_CUSTOM_IO;
  int ret = avformat_open_input(&ctx, NULL, NULL, NULL); // frees ctx on failure, not pb
  if (ret < 0) {
    av_freep(&pb->buffer);
    avio_context_free(&pb);
    return ret;
  }
  *out = ctx;
  return 0;
}

// Bounds stream-info probing (bytes and microseconds); call before sny_find_stream_info.
API void sny_set_probe_limits(AVFormatContext *ctx, int64_t probesize, int64_t analyzeduration) {
  ctx->probesize = probesize;
  ctx->max_analyze_duration = analyzeduration;
}

API int sny_find_stream_info(AVFormatContext *ctx) { return avformat_find_stream_info(ctx, NULL); }

API void sny_close(AVFormatContext *ctx) {
  AVIOContext *pb = ctx->pb;
  avformat_close_input(&ctx);
  if (pb) {
    av_freep(&pb->buffer);
    avio_context_free(&pb);
  }
}

// ---- Container ----

API const char *sny_format_name(const AVFormatContext *ctx) { return ctx->iformat->name; }
API const char *sny_format_long_name(const AVFormatContext *ctx) { return ctx->iformat->long_name; }
API int sny_nb_streams(const AVFormatContext *ctx) { return ctx->nb_streams; }
// Duration and start time are in AV_TIME_BASE units.
API int64_t sny_duration(const AVFormatContext *ctx) { return ctx->duration; }
API int64_t sny_start_time(const AVFormatContext *ctx) { return ctx->start_time; }
API int64_t sny_bit_rate(const AVFormatContext *ctx) { return ctx->bit_rate; }

// Metadata tag of the container (stream = -1) or of a stream; NULL when absent.
API const char *sny_tag(const AVFormatContext *ctx, int stream, const char *key) {
  const AVDictionary *m = stream < 0 ? ctx->metadata : ctx->streams[stream]->metadata;
  const AVDictionaryEntry *e = av_dict_get(m, key, NULL, 0);
  return e ? e->value : NULL;
}

// ---- Streams ----

API AVStream *sny_stream(const AVFormatContext *ctx, int i) { return ctx->streams[i]; }
API int sny_stream_id(const AVStream *st) { return st->id; }
API int sny_stream_tb_num(const AVStream *st) { return st->time_base.num; }
API int sny_stream_tb_den(const AVStream *st) { return st->time_base.den; }
API int64_t sny_stream_start_time(const AVStream *st) { return st->start_time; }
API int64_t sny_stream_duration(const AVStream *st) { return st->duration; }
API int64_t sny_stream_nb_frames(const AVStream *st) { return st->nb_frames; }
API int sny_stream_disposition(const AVStream *st) { return st->disposition; }
API int sny_stream_fps_num(const AVStream *st) { return st->avg_frame_rate.num; }
API int sny_stream_fps_den(const AVStream *st) { return st->avg_frame_rate.den; }

// Codec parameters
API int sny_codec_type(const AVStream *st) { return st->codecpar->codec_type; }
API int sny_codec_id(const AVStream *st) { return st->codecpar->codec_id; }
API const char *sny_codec_name(const AVStream *st) {
  return avcodec_get_name(st->codecpar->codec_id);
}
API unsigned sny_codec_tag(const AVStream *st) { return st->codecpar->codec_tag; }
API int sny_codec_profile(const AVStream *st) { return st->codecpar->profile; }
API int sny_codec_level(const AVStream *st) { return st->codecpar->level; }
// An AVPixelFormat for video, an AVSampleFormat for audio.
API int sny_codec_format(const AVStream *st) { return st->codecpar->format; }
API int64_t sny_codec_bit_rate(const AVStream *st) { return st->codecpar->bit_rate; }
API uint8_t *sny_codec_extradata(const AVStream *st) { return st->codecpar->extradata; }
API int sny_codec_extradata_size(const AVStream *st) { return st->codecpar->extradata_size; }
API int sny_codec_bits_per_raw_sample(const AVStream *st) {
  return st->codecpar->bits_per_raw_sample;
}

// video
API int sny_codec_width(const AVStream *st) { return st->codecpar->width; }
API int sny_codec_height(const AVStream *st) { return st->codecpar->height; }
API int sny_codec_sar_num(const AVStream *st) { return st->codecpar->sample_aspect_ratio.num; }
API int sny_codec_sar_den(const AVStream *st) { return st->codecpar->sample_aspect_ratio.den; }
API int sny_codec_field_order(const AVStream *st) { return st->codecpar->field_order; }
API int sny_codec_color_range(const AVStream *st) { return st->codecpar->color_range; }
API int sny_codec_color_primaries(const AVStream *st) { return st->codecpar->color_primaries; }
API int sny_codec_color_trc(const AVStream *st) { return st->codecpar->color_trc; }
API int sny_codec_color_space(const AVStream *st) { return st->codecpar->color_space; }

// audio
API int sny_codec_sample_rate(const AVStream *st) { return st->codecpar->sample_rate; }
API int sny_codec_channels(const AVStream *st) { return st->codecpar->ch_layout.nb_channels; }
API int sny_codec_frame_size(const AVStream *st) { return st->codecpar->frame_size; }
API int sny_codec_initial_padding(const AVStream *st) { return st->codecpar->initial_padding; }
API int sny_codec_trailing_padding(const AVStream *st) { return st->codecpar->trailing_padding; }

// ---- Packets ----

API AVPacket *sny_packet_alloc(void) { return av_packet_alloc(); }
API void sny_packet_free(AVPacket *pkt) { av_packet_free(&pkt); }

// Reads the next packet into pkt, releasing whatever pkt held. Returns 0 or a negative AVERROR.
API int sny_read(AVFormatContext *ctx, AVPacket *pkt) {
  av_packet_unref(pkt);
  return av_read_frame(ctx, pkt);
}

API int sny_packet_stream(const AVPacket *pkt) { return pkt->stream_index; }
API int64_t sny_packet_pts(const AVPacket *pkt) { return pkt->pts; }
API int64_t sny_packet_dts(const AVPacket *pkt) { return pkt->dts; }
API int64_t sny_packet_duration(const AVPacket *pkt) { return pkt->duration; }
API int64_t sny_packet_pos(const AVPacket *pkt) { return pkt->pos; }
API int sny_packet_flags(const AVPacket *pkt) { return pkt->flags; }
API uint8_t *sny_packet_data(const AVPacket *pkt) { return pkt->data; }
API int sny_packet_size(const AVPacket *pkt) { return pkt->size; }

// ---- Seeking and index ----

// ts is in the stream's time base (stream >= 0) or AV_TIME_BASE units (stream = -1).
API int sny_seek(AVFormatContext *ctx, int stream, int64_t ts, int flags) {
  return av_seek_frame(ctx, stream, ts, flags);
}
API int sny_flush(AVFormatContext *ctx) { return avformat_flush(ctx); }

API int sny_index_count(AVStream *st) { return avformat_index_get_entries_count(st); }
API const AVIndexEntry *sny_index_entry(AVStream *st, int i) {
  return avformat_index_get_entry(st, i);
}
API int64_t sny_index_pos(const AVIndexEntry *e) { return e->pos; }
API int64_t sny_index_ts(const AVIndexEntry *e) { return e->timestamp; }
// A C bitfield, so JS must read it through this getter, never by masking memory.
API int sny_index_flags(const AVIndexEntry *e) { return e->flags; }
API int sny_index_size(const AVIndexEntry *e) { return e->size; }

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
