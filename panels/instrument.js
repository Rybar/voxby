// Instrument panel: oscillator 1/2, noise, envelope, arpeggio, FX and LFO
// controls for the instrument on the currently selected channel, written
// against engine.js's instrument-property-index constants.
//
// The song format ties one instrument to one channel -- there is no separate
// instrument list -- so this panel's "Channel" selector is state.selInstrument,
// shared with the tracker: clicking any sequencer/pattern/fx cell moves it, and
// this panel reflects whatever it is set to. The selector lists all
// engine.MAX_CHANNELS slots rather than state.song.numChannels, matching
// tracker.js's always-16 columns: a channel past numChannels is one with no
// sequence data yet, and its instrument still has to be reachable to set up
// before it is used.
//
// While an FX-track cell is selected (tracker.js's activeFxCell()), every
// slider/icon write here is mirrored into that cell *as well as* the live
// instrument (see setInstrProp), and the controls display the cell's stored
// value on top of the instrument's (see previewInstrI, which panels/keyboard.js
// also reads so the jammer previews exactly what is on screen).
//
// Instrument copy/paste uses a module-local clipboard, leaving state.clipboard
// to the pattern/fx-cell clipboard so the two can't collide.

import * as engine from '../engine.js';
import { state } from '../state.js';
import { svgIcon } from '../icons.js';
import { activeFxCell } from './tracker.js';
import { syncJammer } from './keyboard.js';
import { getAccent } from '../theme.js';
import { render as renderPianoRoll } from './pianoroll.js';

const $ = id => document.getElementById(id);

// [icon, stored value, hover tip]. The tips are why these are triples: the icons
// draw each waveform shape accurately, which says nothing about how it sounds.
const WAVE_ICONS = [
  ['waveSine', 0, 'Sine — a pure tone with no harmonics. Soft; disappears in a mix.'],
  ['waveSquare', 1, 'Square — hollow and buzzy, odd harmonics only. The classic chiptune lead.'],
  ['waveSaw', 2, 'Sawtooth — bright and harsh, every harmonic present. Basses, brass, strings.'],
  ['waveTriangle', 3, 'Triangle — flute-like. A square with the edges taken off.'],
];
const FILTER_ICONS = [
  ['filterLowpass', 2, 'Low-pass — keeps what is below the cutoff. Turn Freq down to darken the sound.'],
  ['filterHighpass', 1, 'High-pass — keeps what is above the cutoff. Thins the sound out, drops the body.'],
  ['filterBandpass', 3, 'Band-pass — keeps a band around the cutoff. Nasal, telephone-like.'],
];

// Linear sliders map straight to the instrument's stored value. The three
// non-linear ones (osc2_det, fx_freq, fx_dist) carry a sqrt/square curve, which
// is what gives them fine control at the low end of their range where it
// matters; it lives in the range input's own value mapping, not in pixel math
// (see bindSlider/refreshSlider).
const SLIDERS = {
  osc1_vol: { prop: engine.OSC1_VOL, min: 0, max: 255 },
  osc1_semi: { prop: engine.OSC1_SEMI, min: 92, max: 164 },
  osc1_xenv: { prop: engine.OSC1_XENV, min: 0, max: 255 },
  osc2_vol: { prop: engine.OSC2_VOL, min: 0, max: 255 },
  osc2_semi: { prop: engine.OSC2_SEMI, min: 92, max: 164 },
  osc2_det: { prop: engine.OSC2_DETUNE, min: 0, max: 255, nonLinear: true },
  osc2_xenv: { prop: engine.OSC2_XENV, min: 0, max: 255 },
  noise_vol: { prop: engine.NOISE_VOL, min: 0, max: 255 },
  env_att: { prop: engine.ENV_ATTACK, min: 0, max: 255 },
  env_sust: { prop: engine.ENV_SUSTAIN, min: 0, max: 255 },
  env_rel: { prop: engine.ENV_RELEASE, min: 0, max: 255 },
  env_decay: { prop: engine.ENV_EXP_DECAY, min: 0, max: 255 },
  arp_speed: { prop: engine.ARP_SPEED, min: 0, max: 7 },
  lfo_amt: { prop: engine.LFO_AMT, min: 0, max: 255 },
  lfo_freq: { prop: engine.LFO_FREQ, min: 0, max: 16 },
  fx_freq: { prop: engine.FX_FREQ, min: 0, max: 255, nonLinear: true },
  fx_res: { prop: engine.FX_RESONANCE, min: 0, max: 254 },
  fx_dist: { prop: engine.FX_DIST, min: 0, max: 255, nonLinear: true },
  fx_drive: { prop: engine.FX_DRIVE, min: 0, max: 255 },
  fx_pan_amt: { prop: engine.FX_PAN_AMT, min: 0, max: 255 },
  fx_pan_freq: { prop: engine.FX_PAN_FREQ, min: 0, max: 16 },
  fx_dly_amt: { prop: engine.FX_DELAY_AMT, min: 0, max: 255 },
  fx_dly_time: { prop: engine.FX_DELAY_TIME, min: 0, max: 16 },
};

let instrClipboard = null;

function currentInstr() {
  return state.song.songData[state.selInstrument];
}

// If an FX-track cell is selected, mirror the write into that cell as well as
// the live instrument property -- both, never one or the other.
function setInstrProp(prop, value) {
  currentInstr().i[prop] = value;
  const cell = activeFxCell();
  if (cell) cell.set(prop, value);
  syncJammer();
  // The piano roll draws each note as wide as this envelope sounds, so an
  // envelope edit must repaint it. A no-op in the tracker view.
  if (prop === engine.ENV_ATTACK || prop === engine.ENV_SUSTAIN || prop === engine.ENV_RELEASE) renderPianoRoll();
}

// Set by main.js's presets dialog while a preset is highlighted there:
// previewInstrI() (and so the sliders and the jammer) show this instrument
// instead of the channel's real one, without touching real song data until
// commitPresetPreview() applies it. Takes priority over the FX-cell preview
// below -- the two dialogs that use them never open at once. null is the
// normal case, nothing being previewed.
let previewPresetI = null;

// Copies rather than keeps `i` itself: a built-in preset's array is the same
// shared object every time presets.js's window.gInstrumentPresets is read
// (main.js never clones it), and previewInstrI() below hands this straight
// out to callers -- a copy is what keeps a downstream mutation from ever
// reaching, and permanently corrupting, the built-in library.
export function setPresetPreview(i) {
  previewPresetI = i.slice();
  refreshInstrumentPanel();
  syncJammer();
}

// A no-op with nothing staged, so main.js can call it unconditionally on
// every dialog-dismiss route (Escape, backdrop, or after a real commit)
// without checking first.
export function clearPresetPreview() {
  if (!previewPresetI) return;
  previewPresetI = null;
  refreshInstrumentPanel();
  syncJammer();
}

// Copies the previewed preset into the real channel instrument in place
// (SoundBox's instrument arrays are always this fixed length, so index-by-
// index is enough -- same as the preset-select handler this replaced).
export function commitPresetPreview() {
  if (!previewPresetI) return;
  const dest = currentInstr().i;
  for (let j = 0; j < dest.length; j++) dest[j] = previewPresetI[j];
  previewPresetI = null;
  refreshInstrumentPanel();
  syncJammer();
}

// The instrument array to *display*: a staged preset preview if one is set,
// else the real instrument, unless an FX cell is selected, in which case
// that cell's stored value previews on top of whichever one property it
// targets. panels/keyboard.js reads this too, so the jammer's live preview
// hears the same instrument these controls show.
export function previewInstrI() {
  if (previewPresetI) return previewPresetI;
  const i = currentInstr().i.slice();
  const cell = activeFxCell();
  if (cell && cell.cmd > 0) i[cell.cmd - 1] = cell.val;
  return i;
}

function iconGroupHTML(id, entries) {
  return `<div class="icon-group" id="${id}" role="radiogroup">`
    + entries.map(([icon, val, tip]) =>
        `<button type="button" data-value="${val}" title="${tip}">${svgIcon(icon)}</button>`).join('')
    + '</div>';
}

function setActiveIcon(id, value) {
  for (const btn of $(id).querySelectorAll('button')) {
    btn.classList.toggle('active', +btn.dataset.value === value);
  }
}

function bindIconGroup(id, prop) {
  $(id).onclick = e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setInstrProp(prop, +btn.dataset.value);
    refreshInstrumentPanel();
  };
}

function sliderRow(id, label, title = '') {
  return `<div class="ctl-row" title="${title}"><label>${label}</label>`
    + `<input type="range" id="${id}"><span class="valuetip"></span></div>`;
}

// screen.css sets input[type=range] to appearance: none so the thumb can be
// shrunk (Chromium ignores ::-webkit-slider-thumb sizing while a range input is
// still natively themed). That gives up accent-color's free "filled track up to
// the thumb" rendering, so this paints an equivalent gradient by hand on every
// value change, in the live accent color.
//
// TRACK_BG is --bg0, the page background, not .instr-card's own --bg2: an unlit
// track the same color as the card it sits on reads as no track at all. It is
// copied as a literal because a gradient stop built in JS can't read a CSS
// variable (panels/scope.js copies its canvas background for the same reason) --
// keep it in sync with screen.css's input[type=range] rule.
const TRACK_BG = '#0d0e11';

function paintFill(el) {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.background = `linear-gradient(to right, ${getAccent()} ${pct}%, ${TRACK_BG} ${pct}%)`;
}

// paintFill() bakes the accent into each slider's inline style at paint time
// rather than reading it live the way CSS's var(--accent) does, so a color
// picked after a slider was last painted needs an explicit repaint --
// theme.js's setAccent() fires 'themechange' for exactly this. A no-op before
// initInstrumentPanel() has created any sliders (initTheme() runs first in
// main.js's boot order and fires one 'themechange' with nothing to find).
document.addEventListener('themechange', () => {
  for (const el of document.querySelectorAll('#instrument-panel input[type=range]')) paintFill(el);
});

function bindSlider(id, def) {
  const el = $(id);
  if (def.nonLinear) { el.min = 0; el.max = 1000; }
  else { el.min = def.min; el.max = def.max; }
  el.step = 1;
  el.oninput = () => {
    const value = def.nonLinear
      ? Math.round(def.min + (def.max - def.min) * (el.value / 1000) ** 2)
      : +el.value;
    setInstrProp(def.prop, value);
    el.nextElementSibling.textContent = value;
    paintFill(el);
  };
}

function refreshSlider(id, def, i) {
  const el = $(id);
  const value = i[def.prop];
  el.value = def.nonLinear
    ? Math.round(1000 * Math.sqrt(Math.min(1, Math.max(0, (value - def.min) / (def.max - def.min)))))
    : value;
  el.nextElementSibling.textContent = value;
  paintFill(el);
}

// The arpeggio's two notes share one byte (ARP_CHORD: high nibble = note 1, low
// nibble = note 2), so they can't go through SLIDERS' one-slider-one-property
// mapping and are bound as a special case.
function bindArpNotes() {
  $('arp_note1').min = $('arp_note2').min = 0;
  $('arp_note1').max = $('arp_note2').max = 12;
  $('arp_note1').oninput = () => {
    const v = +$('arp_note1').value;
    setInstrProp(engine.ARP_CHORD, (currentInstr().i[engine.ARP_CHORD] & 15) | (v << 4));
    $('arp_note1').nextElementSibling.textContent = v;
    paintFill($('arp_note1'));
  };
  $('arp_note2').oninput = () => {
    const v = +$('arp_note2').value;
    setInstrProp(engine.ARP_CHORD, (currentInstr().i[engine.ARP_CHORD] & 240) | v);
    $('arp_note2').nextElementSibling.textContent = v;
    paintFill($('arp_note2'));
  };
}

function refreshArpNotes(i) {
  const chord = i[engine.ARP_CHORD];
  $('arp_note1').value = chord >> 4;
  $('arp_note1').nextElementSibling.textContent = chord >> 4;
  paintFill($('arp_note1'));
  $('arp_note2').value = chord & 15;
  $('arp_note2').nextElementSibling.textContent = chord & 15;
  paintFill($('arp_note2'));
}

// Oscillators, noise+arpeggio and envelope+LFO are each two .instr-sub sections
// stacked inside one .instr-card, so each pairing stays one .instr-grid item
// (Osc1 above Osc2, Arpeggio under Noise, LFO under Envelope). That leaves
// exactly four .instr-card elements including FX, which screen.css's fixed
// 4-column .instr-grid relies on to lay them out in a single row.
export function initInstrumentPanel() {
  $('instrument-panel').classList.remove('wip');
  $('instrument-panel').innerHTML = `
    <div class="instr-header">
      <h3 title="The sound one channel plays. Every note in that channel's patterns uses these settings — one instrument per channel, all the way through the song.">Instrument</h3>
      <label title="Which channel's instrument these controls edit. Clicking any cell in the tracker selects that channel too.">Channel <select id="instr-channel"></select></label>
      <button id="instr-presets-btn" type="button" title="Browse instrument presets — SoundBox's built-in library plus any you've saved — and load one into this channel, overwriting every setting below.">Presets…</button>
      <button id="instr-copy" type="button" title="Copy this whole instrument, to paste onto another channel">${svgIcon('copy')}</button>
      <button id="instr-paste" type="button" title="Overwrite this channel's instrument with the copied one">${svgIcon('paste')}</button>
    </div>
    <div class="instr-grid">
      <div class="instr-card">
        <div class="instr-sub">
          <h4 title="The main tone generator. Oscillator 2 layers a second one on top; Noise adds hiss.">Oscillator 1</h4>
          <div class="ctl-row" title="Waveform: what shape this oscillator draws, which is what decides its timbre."><label>Wave</label>${iconGroupHTML('osc1-wave', WAVE_ICONS)}</div>
          ${sliderRow('osc1_vol', 'Vol', 'How loud this oscillator is. 0 switches it off entirely.')}
          ${sliderRow('osc1_semi', 'Semi', 'Pitch offset in semitones. 128 plays the written note; 116 is an octave down, 140 an octave up.')}
          ${sliderRow('osc1_xenv', 'X-Env', 'Envelope sweeps this oscillator down in pitch as the note decays. The kick-drum and laser-zap control — a little goes a long way.')}
        </div>
        <div class="instr-sub">
          <h4 title="A second oscillator mixed in with the first. Detuned or pitched apart, this is where most of a sound's thickness comes from.">Oscillator 2</h4>
          <div class="ctl-row" title="Waveform for the second oscillator. Mixing two different shapes gives a richer tone than either alone."><label>Wave</label>${iconGroupHTML('osc2-wave', WAVE_ICONS)}</div>
          ${sliderRow('osc2_vol', 'Vol', 'How loud the second oscillator is. 0 switches it off entirely.')}
          ${sliderRow('osc2_semi', 'Semi', 'Pitch offset in semitones. 128 plays the written note; try 135 (a fifth up) or 116 (an octave down) against Oscillator 1.')}
          ${sliderRow('osc2_det', 'Det', 'Fine detune against Oscillator 1. Small amounts thicken the sound; larger ones beat and wobble. Finer at the low end of the slider.')}
          ${sliderRow('osc2_xenv', 'X-Env', 'Envelope sweeps this oscillator down in pitch as the note decays, same as Oscillator 1.')}
        </div>
      </div>
      <div class="instr-card">
        <div class="instr-sub">
          <h4 title="White noise mixed in alongside the oscillators. Filtered noise is where the whole percussion section comes from — snares, hats, wind, surf.">Noise</h4>
          ${sliderRow('noise_vol', 'Vol', 'How much white noise is mixed in. Shape it with the envelope and the FX filter.')}
        </div>
        <div class="instr-sub">
          <h4 title="Cycles each note through up to three pitches while it sounds: the written note, then Note 1, then Note 2. One held note becomes a chord you can hear.">Arpeggio</h4>
          ${sliderRow('arp_note1', 'Note 1', 'Second step of the cycle, in semitones above the written note. 0 leaves the arpeggio flat.')}
          ${sliderRow('arp_note2', 'Note 2', 'Third step of the cycle, in semitones above the written note. 4 and 7 make a major chord, 3 and 7 a minor one.')}
          ${sliderRow('arp_speed', 'Speed', 'How fast the cycle steps. 0 is four rows per step; every notch up halves that, so 7 is a blur.')}
        </div>
      </div>
      <div class="instr-card">
        <div class="instr-sub">
          <h4 title="The shape of a note's volume over time: fade in (Att), hold (Sust), fade out (Rel). Total length is the note's length — patterns trigger notes, they don't hold them.">Envelope</h4>
          ${sliderRow('env_att', 'Att', 'Fade-in time. 0 starts instantly (percussive); high values swell in, for pads and strings.')}
          ${sliderRow('env_sust', 'Sust', 'How long the note holds at full volume after the fade-in, before it starts releasing.')}
          ${sliderRow('env_rel', 'Rel', 'Fade-out time — the tail of the note. This is what makes a sound short and dry or long and ringing.')}
          ${sliderRow('env_decay', 'Exp', 'Bends the fade-out from a straight line into an exponential drop: plucky and front-loaded instead of an even fade.')}
        </div>
        <div class="instr-sub">
          <h4 title="A slow oscillator that sweeps the FX filter cutoff up and down for wah and wobble. It does nothing until FX freq modulation below is ticked.">LFO</h4>
          <div class="ctl-row" title="Shape of the sweep: sine wobbles smoothly, square jumps between two cutoffs, saw ramps and snaps back."><label>Wave</label>${iconGroupHTML('lfo-wave', WAVE_ICONS)}</div>
          ${sliderRow('lfo_amt', 'Amt', 'How far the sweep pushes the filter cutoff. 0 is no movement at all.')}
          ${sliderRow('lfo_freq', 'Freq', 'How fast it sweeps, relative to the row length — so it stays in step with the tempo. Low values are one slow wave over several rows.')}
          <label class="ctl-check" title="Route the LFO to the FX filter cutoff. Nothing the LFO is set to does anything until this is on — it is the LFO's on switch."><input id="lfo_fxfreq" type="checkbox"> FX freq modulation</label>
        </div>
      </div>
      <div class="instr-card instr-card-fx">
        <h4 title="Applied to the whole channel after the notes are mixed, in this order: filter, distortion, drive, panning, delay. The FX track can change any of these mid-pattern.">FX</h4>
        <div class="ctl-row" title="Filter type. This is the single biggest tone control in the synth — most of the difference between a bass and a hi-hat is here."><label>Filt</label>${iconGroupHTML('fx-filter', FILTER_ICONS)}</div>
        <div class="fx-sliders">
          ${sliderRow('fx_freq', 'Freq', 'Filter cutoff, roughly 43 Hz per step — 255 is wide open, low values are muffled. Finer at the low end of the slider.')}
          ${sliderRow('fx_res', 'Res', 'Resonance: emphasises the frequencies right at the cutoff. High values whistle and can get loud, so watch the level.')}
          ${sliderRow('fx_dist', 'Dist', 'Distortion driven into the signal before the output — grit and crunch. Finer at the low end of the slider.')}
          ${sliderRow('fx_drive', 'Drive', 'Output level for this channel. The mix control: use it to balance the channels against each other.')}
          ${sliderRow('fx_pan_amt', 'Pan', 'How far the sound swings between left and right. 0 keeps it centred.')}
          ${sliderRow('fx_pan_freq', 'Pan freq', 'How fast it swings, relative to the row length. Slow values drift across the stereo field.')}
          ${sliderRow('fx_dly_amt', 'Delay', 'How loud the echoes are. 0 is no delay; high values feed back for a long tail.')}
          ${sliderRow('fx_dly_time', 'Delay time', 'Gap between echoes, in rows — so it follows the tempo. 4 is a beat at the default 4 rows per beat.')}
        </div>
      </div>
    </div>`;

  for (const [id, def] of Object.entries(SLIDERS)) bindSlider(id, def);
  bindArpNotes();
  bindIconGroup('osc1-wave', engine.OSC1_WAVEFORM);
  bindIconGroup('osc2-wave', engine.OSC2_WAVEFORM);
  bindIconGroup('lfo-wave', engine.LFO_WAVEFORM);
  bindIconGroup('fx-filter', engine.FX_FILTER);

  $('lfo_fxfreq').onchange = () => setInstrProp(engine.LFO_FX_FREQ, $('lfo_fxfreq').checked ? 1 : 0);

  $('instr-presets-btn').onclick = () => { state.openPresets && state.openPresets(); };

  $('instr-copy').onclick = () => { instrClipboard = currentInstr().i.slice(); };
  $('instr-paste').onclick = () => {
    if (!instrClipboard) return;
    currentInstr().i = instrClipboard.slice();
    refreshInstrumentPanel();
  };

  $('instr-channel').onchange = () => {
    state.selInstrument = +$('instr-channel').value;
    refreshInstrumentPanel();
    $('instr-channel').blur();
  };
}

export function refreshInstrumentPanel() {
  const sel = $('instr-channel');
  if (sel.options.length !== engine.MAX_CHANNELS) {
    sel.innerHTML = Array.from({ length: engine.MAX_CHANNELS }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
  }
  if (state.selInstrument < 0 || state.selInstrument >= engine.MAX_CHANNELS) state.selInstrument = 0;
  sel.value = state.selInstrument;

  const i = previewInstrI();
  setActiveIcon('osc1-wave', i[engine.OSC1_WAVEFORM]);
  setActiveIcon('osc2-wave', i[engine.OSC2_WAVEFORM]);
  setActiveIcon('lfo-wave', i[engine.LFO_WAVEFORM]);
  setActiveIcon('fx-filter', i[engine.FX_FILTER]);

  for (const [id, def] of Object.entries(SLIDERS)) refreshSlider(id, def, i);
  refreshArpNotes(i);

  $('lfo_fxfreq').checked = !!i[engine.LFO_FX_FREQ];
}
