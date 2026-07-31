// Scope panel: a visualizer column next to the on-screen piano (see
// index.html's #keyboard-row), cycling between three draw modes.
//
// drawScope(sources, t) is deliberately source-agnostic: each source only needs
// a getData(t, n) returning n interleaved L/R samples in roughly [-1,1]. Two
// things implement that shape -- player.js's CPlayer (rendered song audio) and
// jammer.js's CJammer (live note preview, which ignores `t` since it is always
// "now" rather than a seekable buffer). main.js's persistent rAF loop hands over
// both every frame and readSamples() below sums them.
//
// The spectrometer's magnitudes come from a direct DFT over a small window
// (SPEC_N=256 samples, SPEC_BINS=24 bins => 6144 multiply-adds per frame,
// trivial at 60fps) rather than a real FFT, whose complexity wouldn't earn its
// keep at this size.

import { getAccent } from '../theme.js';

const $ = id => document.getElementById(id);

const MODES = ['oscilloscope', 'spectrometer', 'spectrogram'];
const MODE_LABEL = { oscilloscope: 'Osc', spectrometer: 'Spec', spectrogram: 'Wfall' };
let modeIndex = 0;

// Matches screen.css's --bg0 -- the canvas draws its own pixels rather than
// being styled, so it can't just inherit the CSS variable.
const BG = '#0d0e11';

function fillBg(ctx, w, h) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
}

export function initScopePanel() {
  $('scope-panel').classList.remove('wip');
  $('scope-panel').innerHTML = `
    <div class="row scope-header">
      <h3 title="Shows everything you can hear — the playing song and anything you play on the keyboard, summed, the same as it reaches your speakers.">Scope</h3>
      <div class="spacer"></div>
      <button id="scope-toggle" type="button" title="Switch view: Osc is the waveform over time, Spec the frequency content right now, Wfall that spectrum scrolling as a heat map">${MODE_LABEL[MODES[modeIndex]]}</button>
    </div>
    <canvas id="scope-canvas" title="Live output. Handy for spotting a note that clips (the wave flattening at the top) or an envelope that is longer or shorter than you meant."></canvas>`;

  // The canvas is sized by its flex layout (screen.css's #scope-canvas rule),
  // so match the backing bitmap to the rendered box -- otherwise CSS stretches
  // a small bitmap and the trace draws blurry.
  const c = $('scope-canvas');
  c.width = c.clientWidth;
  c.height = c.clientHeight;

  $('scope-toggle').onclick = () => {
    modeIndex = (modeIndex + 1) % MODES.length;
    $('scope-toggle').textContent = MODE_LABEL[MODES[modeIndex]];
    // Waterfall mode paints incrementally (see drawSpectrogram) rather than
    // clearing every frame like the other two -- clear once on entry so it
    // doesn't start by scrolling in whatever the previous mode last drew.
    if (MODES[modeIndex] === 'spectrogram') {
      const c = $('scope-canvas');
      fillBg(c.getContext('2d'), c.width, c.height);
    }
  };

  // No explicit clear needed beyond this initial paint: main.js's
  // persistent rAF loop calls drawScope() every frame from boot onward
  // (with a null source until playback/jamming starts), which already
  // fills the background each time.
  drawScope(null, 0);
}

// Reads `n` interleaved L/R samples from every live source and sums them.
// Summing rather than picking one is the honest thing to draw: both sources
// really do reach the speakers at once (jammer.js's ScriptProcessorNode and
// main.js's AudioBufferSourceNode are both connected to the shared context's
// destination), so what you see is what you hear. Picking a winner instead
// hides whichever one lost -- jamming over a song that is mostly silence draws
// a flat line. Their scales already agree (jammer.js's 0.002441481 ==
// player-worker.js's per-note 80x / player.js getData()'s 32768 normalization).
function readSamples(sources, t, n) {
  const out = new Float32Array(n * 2);
  for (const src of sources) {
    const d = src.getData(t, n);
    for (let i = 0; i < n * 2; i++) out[i] += d[i] || 0;
  }
  return out;
}

// Auto-gain, applied per frame to the summed window about to be drawn. Even
// with the right source selected, a single quiet instrument previewed alone
// peaks around 0.02-0.04 -- on this canvas's 68px height that's ~6px of
// movement, technically not a flat line but easy to read as one. Scaling
// each frame to its own peak (like a real auto-ranging scope) makes a lone
// previewed note as legible as a full mix. This only ever touches the
// display copy in readSamples' output, never the audio itself.
//
// The gain is smoothed across frames rather than applied raw: raw per-frame
// normalization makes a decaying note look like it holds constant amplitude
// forever (the gain rises exactly as fast as the note fades) and makes quiet
// passages pump. Falling fast / rising slowly keeps transients honest --
// a note's attack immediately drops the gain, while the recovery back up is
// gradual enough to still read as a decay.
//
// Now also returns the detected peak (0.0-1.0+) for main.js's level meter.
// This runs on the *pre-autogain* samples, so it reflects what actually
// reaches the speakers, not the normalized display.
const AUTOGAIN_FLOOR = 0.01, AUTOGAIN_MAX = 25;
let smoothedGain = 1, lastPeak = 0;
function autoGain(data, n) {
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.abs(data[i * 2]);
    if (s > peak) peak = s;
  }
  lastPeak = peak;
  const target = peak > AUTOGAIN_FLOOR ? Math.min(1 / peak, AUTOGAIN_MAX) : 1;
  smoothedGain += (target - smoothedGain) * (target < smoothedGain ? 0.5 : 0.12);
  return smoothedGain;
}
export function getLastPeak() { return lastPeak; }

function drawOscilloscope(ctx, w, h, data) {
  const gain = autoGain(data, w);
  ctx.strokeStyle = getAccent();
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const sample = Math.max(-1, Math.min(1, data[x * 2] * gain));
    const y = h / 2 - sample * (h / 2 - 2);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

const SPEC_N = 256, SPEC_BINS = 24;
// Precomputed per (bin, sample-index) angle tables -- SPEC_N/SPEC_BINS
// never change, so the cos/sin work only needs doing once rather than every
// frame's DFT.
const SPEC_COS = [], SPEC_SIN = [];
for (let k = 1; k <= SPEC_BINS; k++) {
  const cos = new Float32Array(SPEC_N), sin = new Float32Array(SPEC_N);
  for (let n = 0; n < SPEC_N; n++) {
    const angle = -2 * Math.PI * k * n / SPEC_N;
    cos[n] = Math.cos(angle);
    sin[n] = Math.sin(angle);
  }
  SPEC_COS.push(cos); SPEC_SIN.push(sin);
}

// Per-bin magnitude [0,1], shared by drawSpectrometer (bars) and
// drawSpectrogram (a scrolling column of the same bins, color-coded) so the
// two modes agree on what "loud" means and neither duplicates the DFT.
function spectrumMags(data, gain) {
  const mags = new Float32Array(SPEC_BINS);
  for (let k = 0; k < SPEC_BINS; k++) {
    const cos = SPEC_COS[k], sin = SPEC_SIN[k];
    let re = 0, im = 0;
    for (let n = 0; n < SPEC_N; n++) {
      const sample = data[n * 2] * gain;
      re += sample * cos[n];
      im += sample * sin[n];
    }
    mags[k] = Math.min(1, (Math.sqrt(re * re + im * im) / SPEC_N) * 6);
  }
  return mags;
}

function drawSpectrometer(ctx, w, h, data) {
  const mags = spectrumMags(data, autoGain(data, SPEC_N));
  const barW = w / SPEC_BINS;
  ctx.fillStyle = getAccent();
  for (let k = 0; k < SPEC_BINS; k++) {
    const barH = mags[k] * h;
    ctx.fillRect(k * barW + 1, h - barH, barW - 2, barH);
  }
}

// Heat-map a [0,1] magnitude to a color: near-black at 0, through blue and
// cyan, to yellow/red at 1 -- a standard waterfall palette, chosen so a
// silent bin stays visually indistinguishable from the background rather
// than reading as "some color."
function magColor(mag) {
  return `hsl(${240 - mag * 240},100%,${8 + mag * 55}%)`;
}

// Frequency over time: bins (low at the bottom) on the y axis, time scrolling
// right-to-left on the x axis, magnitude as color.
// Unlike the other two modes this doesn't redraw from scratch every frame
// (there's no way to recompute history that's already scrolled off): it
// shifts the existing canvas one pixel left via a self-copying drawImage
// (a standard, well-defined scrolling-canvas technique -- the spec requires
// implementations to behave as though the source were snapshotted first)
// and paints one new column of SPEC_BINS colored cells at the right edge.
// `data` is null when nothing is making sound this frame (drawScope skips
// readSamples() when there are no live sources) -- draw a blank (silent)
// column rather than skipping the scroll, so the waterfall still visibly
// scrolls through silence instead of freezing.
function drawSpectrogram(ctx, w, h, data) {
  ctx.drawImage(ctx.canvas, -1, 0);
  if (!data) {
    ctx.fillStyle = BG;
    ctx.fillRect(w - 1, 0, 1, h);
    return;
  }
  const mags = spectrumMags(data, autoGain(data, SPEC_N));
  const binH = h / SPEC_BINS;
  for (let k = 0; k < SPEC_BINS; k++) {
    ctx.fillStyle = magColor(mags[k]);
    ctx.fillRect(w - 1, h - (k + 1) * binH, 1, binH + 1);
  }
}

// Called from main.js's persistent rAF loop with every source that could be
// making sound right now (a CPlayer and/or a CJammer -- see this file's top
// comment), summed by readSamples above. Accepts either an array or a single
// source; nulls are filtered out, and no live source at all draws a blank
// canvas. Peak detection runs in autoGain() above; main.js reads it back
// via getLastPeak() to drive the level meter.
export function drawScope(sources, t) {
  const canvas = $('scope-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const live = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);

  if (MODES[modeIndex] === 'spectrogram') {
    drawSpectrogram(ctx, w, h, live.length ? readSamples(live, t, SPEC_N) : null);
    return;
  }

  fillBg(ctx, w, h);
  if (!live.length) { lastPeak = 0; return; }
  if (MODES[modeIndex] === 'spectrometer') drawSpectrometer(ctx, w, h, readSamples(live, t, SPEC_N));
  else drawOscilloscope(ctx, w, h, readSamples(live, t, w));
}
