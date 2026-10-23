// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Video frames and video output: the API of every module that decodes video.

#include "sny.h"

#include <libavutil/display.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
#include <math.h>

// ---- Video frames ----

API int sny_frame_width(const AVFrame *frame) { return frame->width; }
API int sny_frame_height(const AVFrame *frame) { return frame->height; }
API int sny_frame_key(const AVFrame *frame) { return !!(frame->flags & AV_FRAME_FLAG_KEY); }
API int sny_frame_sar_num(const AVFrame *frame) { return frame->sample_aspect_ratio.num; }
API int sny_frame_sar_den(const AVFrame *frame) { return frame->sample_aspect_ratio.den; }
API int sny_frame_color_range(const AVFrame *frame) { return frame->color_range; }
API int sny_frame_color_primaries(const AVFrame *frame) { return frame->color_primaries; }
API int sny_frame_color_trc(const AVFrame *frame) { return frame->color_trc; }
API int sny_frame_color_space(const AVFrame *frame) { return frame->colorspace; }
API int sny_frame_chroma_location(const AVFrame *frame) { return frame->chroma_location; }
// Degrees to rotate the frame counterclockwise for display (its display matrix, from the
// container or the bitstream), truncated as ffprobe reports it, or 0.
API int sny_frame_rotation(const AVFrame *frame) {
  const AVFrameSideData *sd = av_frame_get_side_data(frame, AV_FRAME_DATA_DISPLAYMATRIX);
  double r = sd ? av_display_rotation_get((const int32_t *)sd->data) : 0;
  return isnan(r) ? 0 : (int)r;
}
// FFmpeg's name for the frame's pixel format ("yuv420p", "pal8", …).
API const char *sny_frame_pix_fmt(const AVFrame *frame) {
  return av_get_pix_fmt_name(frame->format);
}
// Plane i and its bytes per row (which may exceed the visible width).
API uint8_t *sny_frame_data(const AVFrame *frame, int i) { return frame->data[i]; }
API int sny_frame_linesize(const AVFrame *frame, int i) { return frame->linesize[i]; }

// ---- Video output ----

// The pixel formats of a WebCodecs VideoFrame, with their names, at any size: each one that
// Chromium constructs and imports into WebGPU, which leaves out 12-bit with alpha. The yuvj formats
// are deprecated full-range aliases that decoders such as MJPEG still output; they are accepted but
// never converted to (sny_frame_color_range gives the range).
static const struct {
  enum AVPixelFormat format;
  const char *name;
  int alias;
} video_formats[] = {
    {AV_PIX_FMT_YUV420P, "I420"},        {AV_PIX_FMT_YUVJ420P, "I420", 1},
    {AV_PIX_FMT_YUV420P10LE, "I420P10"}, {AV_PIX_FMT_YUV420P12LE, "I420P12"},
    {AV_PIX_FMT_YUVA420P, "I420A"},      {AV_PIX_FMT_YUVA420P10LE, "I420AP10"},
    {AV_PIX_FMT_YUV422P, "I422"},        {AV_PIX_FMT_YUVJ422P, "I422", 1},
    {AV_PIX_FMT_YUV422P10LE, "I422P10"}, {AV_PIX_FMT_YUV422P12LE, "I422P12"},
    {AV_PIX_FMT_YUVA422P, "I422A"},      {AV_PIX_FMT_YUVA422P10LE, "I422AP10"},
    {AV_PIX_FMT_YUV444P, "I444"},        {AV_PIX_FMT_YUVJ444P, "I444", 1},
    {AV_PIX_FMT_YUV444P10LE, "I444P10"}, {AV_PIX_FMT_YUV444P12LE, "I444P12"},
    {AV_PIX_FMT_YUVA444P, "I444A"},      {AV_PIX_FMT_YUVA444P10LE, "I444AP10"},
    {AV_PIX_FMT_NV12, "NV12"},           {AV_PIX_FMT_RGBA, "RGBA"},
    {AV_PIX_FMT_RGB0, "RGBX"},           {AV_PIX_FMT_BGRA, "BGRA"},
    {AV_PIX_FMT_BGR0, "BGRX"},
};

#define NB_VIDEO_FORMATS (int)(sizeof video_formats / sizeof *video_formats)

static const char *video_format(const AVFrame *frame) {
  for (int i = 0; i < NB_VIDEO_FORMATS; i++)
    if (video_formats[i].format == frame->format)
      return video_formats[i].name;
  return NULL;
}

// The VideoFrame format of frame ("I420", "NV12", "RGBA", …), or NULL when it must go through
// sny_to_video_format first.
API const char *sny_frame_video_format(const AVFrame *frame) { return video_format(frame); }

// The yuvj formats are full-range yuv ones, the range being a frame property; as themselves,
// avcodec_find_best_pix_fmt_of_list counts them as another colour model and picks RGB.
static enum AVPixelFormat without_range(enum AVPixelFormat format) {
  switch (format) {
  case AV_PIX_FMT_YUVJ420P:
    return AV_PIX_FMT_YUV420P;
  case AV_PIX_FMT_YUVJ422P:
    return AV_PIX_FMT_YUV422P;
  case AV_PIX_FMT_YUVJ444P:
    return AV_PIX_FMT_YUV444P;
  case AV_PIX_FMT_YUVJ440P:
    return AV_PIX_FMT_YUV440P;
  case AV_PIX_FMT_YUVJ411P:
    return AV_PIX_FMT_YUV411P;
  default:
    return format;
  }
}

// A scaler holds the libswscale state between frames.
API SwsContext *sny_scaler_alloc(void) { return sws_alloc_context(); }
API void sny_scaler_free(SwsContext *sws) { sws_free_context(&sws); }

// Makes out a frame VideoFrame accepts: in itself (referenced, not copied) when it has a
// VideoFrame format, otherwise in converted by libswscale, at the same size, to the nearest
// such format (rgb24 to RGBX, …). Returns 0 or a negative AVERROR.
API int sny_to_video_format(SwsContext *sws, const AVFrame *in, AVFrame *out) {
  av_frame_unref(out);
  if (video_format(in))
    return av_frame_ref(out, in);

  const AVPixFmtDescriptor *desc = av_pix_fmt_desc_get(in->format);
  if (!desc)
    return AVERROR(EINVAL);
  // RGB, XYZ and gray stay RGB: their frames carry no YUV matrix to convert with.
  const int rgb =
      (desc->flags & (AV_PIX_FMT_FLAG_RGB | AV_PIX_FMT_FLAG_XYZ)) || desc->nb_components < 3;
  enum AVPixelFormat accepted[NB_VIDEO_FORMATS + 1];
  int n = 0;
  for (int i = 0; i < NB_VIDEO_FORMATS; i++)
    if (!video_formats[i].alias &&
        (!rgb || av_pix_fmt_desc_get(video_formats[i].format)->flags & AV_PIX_FMT_FLAG_RGB))
      accepted[n++] = video_formats[i].format;
  accepted[n] = AV_PIX_FMT_NONE;
  // libswscale reads both frames' colour properties: copied first, YUV stays in the source's
  // range and matrix instead of being squeezed to limited range; RGB is full range.
  int ret = av_frame_copy_props(out, in);
  if (ret < 0) {
    av_frame_unref(out);
    return ret;
  }
  out->format = avcodec_find_best_pix_fmt_of_list(accepted, without_range(in->format),
                                                  !!(desc->flags & AV_PIX_FMT_FLAG_ALPHA), NULL);
  out->width = in->width;
  out->height = in->height;
  if (av_pix_fmt_desc_get(out->format)->flags & AV_PIX_FMT_FLAG_RGB) {
    out->colorspace = AVCOL_SPC_RGB;
    out->color_range = AVCOL_RANGE_JPEG;
  }
  ret = sws_scale_frame(sws, out, in);
  if (ret < 0)
    av_frame_unref(out);
  return ret < 0 ? ret : 0;
}

// Bytes sny_frame_pack writes: the frame's planes tightly packed, in the layout
// new VideoFrame(data, {format, codedWidth, codedHeight}) assumes when given none.
API int sny_frame_pack_size(const AVFrame *frame) {
  return av_image_get_buffer_size(frame->format, frame->width, frame->height, 1);
}

// Copies the frame's planes to dst (sny_frame_pack_size bytes) in that layout: one copy
// from the decoder to a VideoFrame. Returns the bytes written or a negative AVERROR.
API int sny_frame_pack(const AVFrame *frame, uint8_t *dst, int size) {
  return av_image_copy_to_buffer(dst, size, (const uint8_t *const *)frame->data, frame->linesize,
                                 frame->format, frame->width, frame->height, 1);
}
