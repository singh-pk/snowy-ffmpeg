// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// A ring of audio in a SharedArrayBuffer, from the media worker to the AudioWorklet: 32-bit
// float samples, channels interleaved, at the rate the ring was made for. The producer
// blocks (Atomics.wait) while the ring is full; the worklet never waits: an empty ring is an
// underrun, and it plays silence.
//
// The ring also carries the clock the worklet publishes: the media time of the next sample it
// will play, the context time it plays at, and whether it is playing or underrun. It advances
// only by samples played, so it cannot drift from the audio, and it stops on an underrun.
// The main thread adds the context's output timestamp, the one thing only it can read: which
// context time is being heard at which moment, so any thread knows what is heard now.
//
// Positions count frames (one sample per channel), only grow, and wrap as 32-bit integers.

// Control words.
const WRITE = 0;
const READ = 1;
const PRODUCER_WAITING = 2;
const CLOSED = 3;
const CHANNELS = 4;
const RATE = 5;
// The clock: odd while the worklet writes it, so a reader that sees it odd or changed reads
// again (a seqlock). Then the frames played and the context frame the next one plays at, each
// as two 32-bit halves, and whether it is playing. Every word is read and written with
// Atomics, so a reader that sees the sequence unchanged saw one consistent clock.
const SEQUENCE = 6;
const PLAYED = 7;
const FRAME = 9;
const PLAYING = 11;
// A Float64 word, set before the first frame: the media time of the first frame. Plain, not
// atomic: the stores of WRITE and SEQUENCE that follow publish it, so a reader sees it once
// the clock has played a frame, and may see 0 before.
const START = 7;
// The output timestamp, written by the main thread under a seqlock of its own, every word
// with Atomics as for the clock: the context time being heard and when, in whole
// microseconds as two 32-bit halves each, and whether the context is running.
const OUTPUT_SEQUENCE = 16;
const OUTPUT_RUNNING = 17;
const OUTPUT_TIME = 18;
const OUTPUT_AT = 20;
const DATA = 128;
const HALF = 2 ** 32;

/** The name of the AudioWorkletProcessor that plays a ring (src/audio.worklet.ts). */
export const AUDIO_PROCESSOR = "snowy-audio";

/** Its options: the ring it plays. */
export interface AudioOptions {
  ring: SharedArrayBuffer;
}

/**
 * The clock: `pts` is the media time, in seconds, of the sample that plays at context time
 * `time`, when the context renders it, before its output latency. Not exported: readers get
 * the object `createPcmControl` reuses.
 */
interface Clock {
  pts: number;
  time: number;
  /** False after an underrun, and before the first sample: the clock is stopped at `pts`. */
  playing: boolean;
}

/** A ring of `frames` frames, a power of two, of `channels` channels at `rate` Hz. */
export function createPcmRing(frames: number, channels: number, rate: number) {
  if (frames < 1 || (frames & (frames - 1)) !== 0) {
    throw new RangeError(`PCM ring of ${frames} frames is not a power of two`);
  }

  if (!Number.isInteger(channels) || channels < 1 || !Number.isInteger(rate) || rate < 1) {
    throw new RangeError(`PCM ring of ${channels} channels at ${rate} Hz`);
  }

  const ring = new SharedArrayBuffer(DATA + frames * channels * 4);
  const control = new Int32Array(ring, 0, DATA / 4);
  control[CHANNELS] = channels;
  control[RATE] = rate;
  return ring;
}

function views(ring: SharedArrayBuffer) {
  const control = new Int32Array(ring, 0, DATA / 4);
  const channels = control[CHANNELS] ?? 1;
  const samples = new Float32Array(ring, DATA);
  return {
    control,
    times: new Float64Array(ring, 0, DATA / 8),
    samples,
    channels,
    rate: control[RATE] ?? 0,
    capacity: samples.length / channels,
  };
}

/** The channel count and sample rate `ring` was made for. */
export function pcmFormat(ring: SharedArrayBuffer) {
  const { channels, rate } = views(ring);
  return { channels, rate };
}

/** The producer's side of `ring`, for a thread that may block. */
export function createPcmProducer(ring: SharedArrayBuffer) {
  const { control, times, samples, channels, capacity } = views(ring);

  /** Sets the media time, in seconds, of the first frame; before the first write. */
  function start(seconds: number) {
    times[START] = seconds;
  }

  /**
   * Copies `frames` frames of `src` from index `offset` into the ring, as room frees up. False
   * once the consumer has closed the ring, so the producer stops.
   */
  function write(src: Float32Array, offset: number, frames: number) {
    let from = offset;
    let left = frames;

    while (left > 0) {
      const written = control[WRITE] ?? 0;
      const read = Atomics.load(control, READ);
      if (Atomics.load(control, CLOSED)) return false;
      const free = capacity - ((written - read) | 0);

      if (free === 0) {
        // Raised before waiting, so a read after the check above notifies this wait or
        // changes READ before it starts.
        Atomics.store(control, PRODUCER_WAITING, 1);
        Atomics.wait(control, READ, read);
        Atomics.store(control, PRODUCER_WAITING, 0);
        continue;
      }

      const n = Math.min(free, left);
      const at = written & (capacity - 1);
      const first = Math.min(n, capacity - at) * channels;
      samples.set(src.subarray(from, from + first), at * channels);
      if (first < n * channels) samples.set(src.subarray(from + first, from + n * channels), 0);
      Atomics.store(control, WRITE, (written + n) | 0);
      from += n * channels;
      left -= n;
    }

    return true;
  }

  return { start, write };
}

/** The AudioWorklet's side of `ring`: it never blocks. */
export function createPcmConsumer(ring: SharedArrayBuffer) {
  const { control, samples, channels, capacity } = views(ring);
  // Frames played since the start, exact in a double for millions of years at any rate.
  let played = 0;

  function publish(next: number, playing: boolean) {
    const sequence = control[SEQUENCE] ?? 0;
    Atomics.store(control, SEQUENCE, (sequence + 1) | 0);
    Atomics.store(control, PLAYED, played % HALF);
    Atomics.store(control, PLAYED + 1, Math.floor(played / HALF));
    Atomics.store(control, FRAME, next % HALF);
    Atomics.store(control, FRAME + 1, Math.floor(next / HALF));
    Atomics.store(control, PLAYING, playing ? 1 : 0);
    Atomics.store(control, SEQUENCE, (sequence + 2) | 0);
  }

  /**
   * Fills `output`, one array per channel, with the next frames, and silence where the ring
   * runs out; `frame` is the context's frame of its first frame (`currentFrame`). Publishes
   * the clock.
   */
  function read(output: Float32Array[], frame: number) {
    const frames = output[0]?.length ?? 0;
    const at = control[READ] ?? 0;
    const available = Atomics.load(control, CLOSED) ? 0 : (Atomics.load(control, WRITE) - at) | 0;
    const n = Math.min(frames, available);

    // Indexed loops: an iterator would allocate on the audio thread every quantum.
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      if (!out) continue;
      const filled = c < channels ? n : 0;
      for (let i = 0; i < filled; i++)
        out[i] = samples[((at + i) & (capacity - 1)) * channels + c] ?? 0;
      out.fill(0, filled);
    }

    if (n > 0) {
      Atomics.store(control, READ, (at + n) | 0);
      if (Atomics.load(control, PRODUCER_WAITING)) Atomics.notify(control, READ);
    }

    played += n;
    publish(frame + frames, n === frames && n > 0);
  }

  /** Whether the ring is closed: nothing will play from it again. */
  function closed() {
    return Atomics.load(control, CLOSED) === 1;
  }

  return { read, closed };
}

/** The side of `ring` for any other thread: the clock, how full it is, and stopping it. */
export function createPcmControl(ring: SharedArrayBuffer) {
  const { control, times, rate } = views(ring);
  const clock: Clock = { pts: 0, time: 0, playing: false };
  const whole = (at: number) =>
    Atomics.load(control, at + 1) * HALF + (Atomics.load(control, at) >>> 0);

  /** The clock as last published; the object is reused. */
  function read() {
    for (;;) {
      const sequence = Atomics.load(control, SEQUENCE);
      if (sequence & 1) continue;
      const played = whole(PLAYED);
      const frame = whole(FRAME);
      const playing = Atomics.load(control, PLAYING) === 1;
      if (Atomics.load(control, SEQUENCE) !== sequence) continue;
      clock.pts = (times[START] ?? 0) + played / rate;
      clock.time = frame / rate;
      clock.playing = playing;
      return clock;
    }
  }

  /** The media time, in seconds, playing at context time `time`. */
  function mediaTime(time: number) {
    const { pts, time: at, playing } = read();
    return playing ? pts + time - at : pts;
  }

  /**
   * Publishes the context's output timestamp, from the main thread: context time
   * `contextTime` is heard at `at`, in milliseconds on the clock of `performance.timeOrigin +
   * performance.now()`, which every thread shares; and whether the context is running.
   */
  function publishOutput(contextTime: number, at: number, running: boolean) {
    const sequence = control[OUTPUT_SEQUENCE] ?? 0;
    const time = Math.round(contextTime * 1e6);
    const when = Math.round(at * 1e3);
    Atomics.store(control, OUTPUT_SEQUENCE, (sequence + 1) | 0);
    Atomics.store(control, OUTPUT_TIME, time % HALF);
    Atomics.store(control, OUTPUT_TIME + 1, Math.floor(time / HALF));
    Atomics.store(control, OUTPUT_AT, when % HALF);
    Atomics.store(control, OUTPUT_AT + 1, Math.floor(when / HALF));
    Atomics.store(control, OUTPUT_RUNNING, running ? 1 : 0);
    Atomics.store(control, OUTPUT_SEQUENCE, (sequence + 2) | 0);
  }

  /**
   * The media time, in seconds, heard at `at` (milliseconds, as for `publishOutput`): the
   * context time heard then, from the last output timestamp, carried forward while the context
   * runs, through the clock.
   */
  function heard(at: number) {
    for (;;) {
      const sequence = Atomics.load(control, OUTPUT_SEQUENCE);
      if (sequence & 1) continue;
      const time = whole(OUTPUT_TIME) / 1e6;
      const when = whole(OUTPUT_AT) / 1e3;
      const running = Atomics.load(control, OUTPUT_RUNNING) === 1;
      if (Atomics.load(control, OUTPUT_SEQUENCE) !== sequence) continue;
      return mediaTime(running ? time + (at - when) / 1000 : time);
    }
  }

  /** The frames written and not yet played. */
  function buffered() {
    return (Atomics.load(control, WRITE) - Atomics.load(control, READ)) | 0;
  }

  /** The media time, in seconds, of the first frame, once the clock has played it. */
  function start() {
    return times[START] ?? 0;
  }

  /** Stops the producer: its next write returns false, and a waiting one wakes up. */
  function close() {
    Atomics.store(control, CLOSED, 1);
    Atomics.store(control, READ, Atomics.load(control, WRITE));
    Atomics.notify(control, READ);
  }

  return { read, mediaTime, publishOutput, heard, buffered, start, close };
}
