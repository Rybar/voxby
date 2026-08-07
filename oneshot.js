// Render one short sound, here and now, on the main thread.
//
// Everything else in this editor renders through player.js's CPlayer, which
// posts a song to a worker and calls back. That is right for a song: a minute
// of music takes seconds to generate, and the UI has to stay alive. It is
// wrong for a sound effect. A zap is a third of a second of audio; rendering
// it takes a few milliseconds, and going through a worker to get it means the
// waveform arrives a frame or two after the sound did -- which is exactly the
// lag that makes a meter feel disconnected from the knob that moved it.
//
// So this drives player-core.js's CPlayerWorker directly. Same renderer the
// worker runs, same output, no round trip. It is only ever handed the
// one-channel songs sfx.js builds, which is what makes that safe: the cost is
// bounded by how long a sound effect is allowed to be.
//
// The buffer is interleaved stereo Int32, full scale 32768 (player.js's
// getData divides by exactly that, and createWave clamps at 32767) -- so a
// peak at or above 1 here is a sound that will clip on the way out.

import { CPlayerWorker } from './player-core.js';

export const SAMPLE_RATE = 44100;
export const FULL_SCALE = 32768;

// One renderer, reused. init() rebuilds every field it touches, so there is
// nothing to carry between renders, and a fresh one per keystroke would
// allocate a work buffer each time for no reason.
const player = new CPlayerWorker();

// { samples, peak, clipped, seconds }, where `samples` is the interleaved
// stereo buffer and `peak` is in [0, ~) with 1 meaning full scale.
export function renderOneShot(song) {
  // null, not {}: init() takes any object at all as "the caller gave me all
  // four range fields" and reads them straight out, so an empty one sets
  // lastCol to undefined and the column loop renders nothing. null is what
  // asks for the defaults -- the whole song, every channel.
  player.init(song, null);
  player.generate();
  const samples = player.getBuf();
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > peak) peak = v;
  }
  return {
    samples,
    peak: peak / FULL_SCALE,
    clipped: peak >= 32767,
    seconds: samples.length / 2 / SAMPLE_RATE,
  };
}

// Min/max per column of pixels, for drawing the buffer as a waveform.
//
// Min and max rather than one value per column: a 0.3 s sound is 13,000
// samples and a canvas column is maybe 3 of them wide, so anything that picks
// a single sample per column draws an aliased mess that changes shape as the
// canvas resizes. The envelope between the extremes is the honest picture, and
// it is what makes a clipped sound look flat-topped rather than merely loud.
//
// The two channels are summed to mono first: this is a "how loud, how long,
// what shape" readout, and two overlaid traces say nothing extra about a sound
// whose only stereo content is an LFO pan.
export function waveformBands(samples, columns) {
  const frames = samples.length / 2;
  const bands = new Float32Array(columns * 2);
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * frames / columns);
    const to = Math.max(from + 1, Math.floor((c + 1) * frames / columns));
    let lo = 0, hi = 0;
    for (let f = from; f < to; f++) {
      const v = (samples[f * 2] + samples[f * 2 + 1]) / 2 / FULL_SCALE;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    bands[c * 2] = lo;
    bands[c * 2 + 1] = hi;
  }
  return bands;
}
