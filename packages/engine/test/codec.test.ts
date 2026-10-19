// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Codec strings from bitstream fields, in Bun, for what the fixtures do not cover: the HEVC
// example of ISO/IEC 14496-15 Annex E, a VP9 profile 2 keyframe, AV1 sequence headers with
// the fields the fixtures leave out, and a codec WebCodecs does not decode. test/video.test.ts checks every fixture in the browsers.
// Usage: bun test test/codec.test.ts

import { expect, test } from "bun:test";
import { hevcCodec, videoConfig, vp9Codec } from "../src/codec";

test("HEVC: Main profile, level 3.1, progressive (ISO/IEC 14496-15 Annex E)", () => {
  // profile_space 0, tier 0, profile_idc 1; compatibility flags 1 and 2; constraint flags
  // progressive_source, non_packed and frame_only; level_idc 93.
  const ptl = new Uint8Array([0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93]);
  expect(hevcCodec("hev1", ptl)).toBe("hev1.1.6.L93.B0");
});

test("HEVC: high tier, profile space 1, every constraint byte set", () => {
  const ptl = new Uint8Array([0x62, 0x80, 0, 0, 1, 1, 2, 3, 4, 5, 6, 120]);
  // Compatibility 0x80000001 reversed is 0x80000001.
  expect(hevcCodec("hvc1", ptl)).toBe("hvc1.A2.80000001.H120.01.02.03.04.05.06");
});

test("VP9: profile 2, 10-bit, with the level from the picture size", () => {
  // frame_marker 2, profile 2 (low bit 0, high bit 1), not an existing frame, a keyframe,
  // shown, not error resilient; the sync code; 10-bit.
  const keyframe = new Uint8Array([0b1001_0010, 0x49, 0x83, 0x42, 0b0000_0000]);
  expect(vp9Codec(keyframe, 256, 144, -99)).toBe("vp09.02.10.10");
  expect(vp9Codec(keyframe, 1920, 1080, -99)).toBe("vp09.02.40.10");
  expect(vp9Codec(keyframe, 1920, 1080, 41)).toBe("vp09.02.41.10");
});

// Bytes from [value, bits] fields, most significant bit first, padded with zeros.
function pack(fields: [number, number][]) {
  const bits = fields.flatMap(([v, n]) =>
    Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (n - 1 - i)) % 2),
  );
  return new Uint8Array(
    Array.from({ length: Math.ceil(bits.length / 8) }, (_, k) =>
      bits.slice(8 * k, 8 * k + 8).reduce((b, bit, i) => b | (bit << (7 - i)), 0),
    ),
  );
}

// A temporal delimiter, then a sequence header OBU with `payload`, each with its size.
const obus = (payload: Uint8Array) => new Uint8Array([0x12, 0, 0x0a, payload.length, ...payload]);

const av1 = (keyframe: Uint8Array) =>
  videoConfig(
    { codec: "av1", tag: "", extradata: new Uint8Array(), width: 1920, height: 1080, level: -99 },
    keyframe,
  ).codec;

test("AV1: timing and decoder model information, two operating points, high tier, 10-bit", () => {
  const header = pack([
    [0, 3], // seq_profile
    [0, 1], // still_picture
    [0, 1], // reduced_still_picture_header
    [1, 1], // timing_info_present_flag
    [1, 32], // num_units_in_display_tick
    [30, 32], // time_scale
    [1, 1], // equal_picture_interval
    [1, 1], // num_ticks_per_picture_minus_1: uvlc() 0
    [1, 1], // decoder_model_info_present_flag
    [9, 5], // buffer_delay_length_minus_1
    [1, 32], // num_units_in_decoding_tick
    [0, 5], // buffer_removal_time_length_minus_1
    [0, 5], // frame_presentation_time_length_minus_1
    [1, 1], // initial_display_delay_present_flag
    [1, 5], // operating_points_cnt_minus_1
    [0, 12], // operating_point_idc[0]
    [12, 5], // seq_level_idx[0]: 6.0
    [1, 1], // seq_tier[0]
    [1, 1], // decoder_model_present_for_this_op[0]
    [1000, 10], // decoder_buffer_delay
    [513, 10], // encoder_buffer_delay
    [0, 1], // low_delay_mode_flag
    [1, 1], // initial_display_delay_present_for_this_op[0]
    [9, 4], // initial_display_delay_minus_1
    [0x30f, 12], // operating_point_idc[1]
    [9, 5], // seq_level_idx[1]: 3.1
    [1, 1], // seq_tier[1]
    [0, 1], // decoder_model_present_for_this_op[1]
    [0, 1], // initial_display_delay_present_for_this_op[1]
    [10, 4], // frame_width_bits_minus_1
    [10, 4], // frame_height_bits_minus_1
    [1919, 11], // max_frame_width_minus_1
    [1079, 11], // max_frame_height_minus_1
    [1, 1], // frame_id_numbers_present_flag
    [0, 4], // delta_frame_id_length_minus_2
    [0, 3], // additional_frame_id_length_minus_1
    [0b011, 3], // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
    [0, 4], // interintra, masked, warped motion, dual filter
    [1, 1], // enable_order_hint
    [0, 2], // enable_jnt_comp, enable_ref_frame_mvs
    [0, 1], // seq_choose_screen_content_tools
    [1, 1], // seq_force_screen_content_tools
    [0, 1], // seq_choose_integer_mv
    [0, 1], // seq_force_integer_mv
    [1, 3], // order_hint_bits_minus_1
    [0b000, 3], // enable_superres, enable_cdef, enable_restoration
    [1, 1], // high_bitdepth
  ]);
  expect(av1(obus(header))).toBe("av01.0.12H.10");
});

test("AV1: a reduced still picture header, profile 2, 12-bit", () => {
  const header = pack([
    [2, 3], // seq_profile
    [1, 1], // still_picture
    [1, 1], // reduced_still_picture_header
    [5, 5], // seq_level_idx[0]
    [7, 4], // frame_width_bits_minus_1
    [7, 4], // frame_height_bits_minus_1
    [255, 8], // max_frame_width_minus_1
    [255, 8], // max_frame_height_minus_1
    [0, 3], // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
    [0, 3], // enable_superres, enable_cdef, enable_restoration
    [1, 1], // high_bitdepth
    [1, 1], // twelve_bit
  ]);
  expect(av1(obus(header))).toBe("av01.2.05M.12");
});

test("a codec WebCodecs does not decode is an error", () => {
  const p = {
    codec: "mpeg4",
    tag: "",
    extradata: new Uint8Array(),
    width: 2,
    height: 2,
    level: -99,
  };
  expect(() => videoConfig(p, new Uint8Array())).toThrow("not a codec WebCodecs decodes");
});
