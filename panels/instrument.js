// Instrument panel (plans/soundbox-revamp.md Phase 3 Stage C). Renders
// oscillator 1/2, noise, envelope, arpeggio, FX, and LFO controls for the
// instrument on the currently selected channel, against engine.js's plain
// instrument-property-index constants. Replaces gui.js's drag-an-<img>
// slider widget with native <input type="range">, and its .src-swap
// waveform/filter pickers with SVG icon toggle-groups.
//
// SoundBox ties one instrument to one channel (gui.js read/wrote
// mSong.songData[mSeq.col()].i, mSeq being the sequencer's column
// cursor) -- there's no separate "instrument list". This panel's own
// "Channel" selector (state.selInstrument) is now shared with Stage D's
// tracker: clicking any sequencer/pattern/fx cell moves state.selInstrument
// to that cell's channel, and this panel just reflects whatever it's set
// to. The selector lists all engine.MAX_CHANNELS slots (not
// state.song.numChannels) because tracker.js also renders all 16 sequencer
// columns always -- a channel past the current numChannels is simply one
// with no sequence data yet, and needs to stay reachable here too so its
// instrument can be set up before it's used.
//
// Also wired to Stage D: while a Fx-track cell is selected
// (tracker.js's activeFxCell()), every slider/icon write here is mirrored
// into that cell instead of (well, in addition to -- see setInstrProp)
// just the live instrument, and the sliders preview the cell's stored
// value rather than the instrument's -- gui.js's updateInstrument()/
// mouseMove EDIT_FXTRACK branches, ported the same way.
//
// Instrument copy/paste uses its own module-local clipboard rather than
// state.clipboard -- that field is left free for Stage D's pattern/fx-cell
// clipboard so the two don't collide.
//
// previewInstrI() is exported for panels/keyboard.js (Stage E): the
// jammer's live-preview audio is kept in sync with whatever this panel is
// currently displaying (the live instrument, or an FX cell's stored value
// while one is selected).
//
// Dropped vs. gui.js: the "Save instrument" button (downloaded a single
// instrument as a raw binary data: URI) and presetOnKeyDown's
// arrow-key-ignoring guard on the preset <select> -- both small legacy
// conveniences, neither asked for, both inconsistent with how every other
// export in this tool already works (a real Blob download, or a plain
// native control with no extra guard). "Display file size" (a periodic
// export-size readout) is also dropped, same reasoning as Stage B's other
// trims: nothing in the new UI reads it.

import * as engine from '../engine.js';
import { state } from '../state.js';
import { svgIcon } from '../icons.js';
import { activeFxCell } from './tracker.js';
import { getAccent } from '../theme.js';

const $ = id => document.getElementById(id);

// [icon, stored value, hover tip]. The tips (Stage E.18, the plan's last
// section) are the whole reason these are triples: the icons draw the waveform
// shape accurately, which says nothing about what it sounds like.
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
// non-linear ones (osc2_det, fx_freq, fx_dist) keep gui.js's sqrt/square
// curve (sliderMouseDown/updateSlider in the old code) so fine control at
// the low end of the range is preserved -- ported as the range input's own
// value mapping (see bindSlider/refreshSlider) rather than reimplemented
// as pixel math.
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

// If an FX-track cell is selected, mirror the write into that cell too --
// gui.js's mouseMove/icon-click handlers always did both (fx cell AND the
// live instrument property), not one or the other; ported as-is.
function setInstrProp(prop, value) {
  currentInstr().i[prop] = value;
  const cell = activeFxCell();
  if (cell) cell.set(prop, value);
  $('instr-preset').value = '';
}

// The instrument array to *display*: the real instrument, unless an FX
// cell is selected, in which case that cell's stored value previews on top
// of whichever one property it targets -- gui.js's updateInstrument()
// building instrI = deepCopy(...) then overriding instrI[fxCmd[0]-1].
// Exported for panels/keyboard.js (Stage E): the jammer's live-preview
// audio should hear the same previewed instrument these controls display.
export function previewInstrI() {
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

// Stage E.8: screen.css switched input[type=range] to appearance: none so
// the thumb could be shrunk (Chromium ignores ::-webkit-slider-thumb sizing
// while a range input is still natively themed) -- that traded away
// accent-color's free "filled track up to the thumb" rendering, so this
// repaints an equivalent gradient by hand on every value change. Stage E.9:
// the filled portion tracks the live (user-adjustable) accent color via
// theme.js instead of a hardcoded hex, same as screen.css's var(--accent)
// does for everything else. Stage E.12: the unfilled portion was --bg2,
// which is also .instr-card's background -- an unlit track was invisible
// against the card it sat on, so only the accent fill read as a slider.
// TRACK_BG is --bg0, the (darker) page background, copied as a literal the
// same way panels/scope.js copies it for its canvas fills: a gradient stop
// built in JS can't read the CSS variable. Keep it in sync with
// screen.css's input[type=range] rule.
const TRACK_BG = '#0d0e11';

function paintFill(el) {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.background = `linear-gradient(to right, ${getAccent()} ${pct}%, ${TRACK_BG} ${pct}%)`;
}

// Stage E.10: paintFill() bakes getAccent() into each slider's inline style
// at paint time rather than reading it live like CSS's var(--accent) does,
// so a color picked after a slider was last painted needs an explicit
// repaint -- theme.js's setAccent() fires 'themechange' for exactly this.
// Harmless no-op before initInstrumentPanel() has created any sliders yet
// (initTheme() runs first in main.js's boot sequence and applies the
// restored/default accent, firing one 'themechange' with nothing to find).
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

// The arpeggio's two notes share one byte (ARP_CHORD: high nibble = note
// 1, low nibble = note 2) -- kept as a special case rather than folded
// into SLIDERS, same as gui.js's mouseMove handler did.
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

function presetOptionsHTML() {
  return '<option value="">(select a preset)</option>' + window.gInstrumentPresets.map((p, i) =>
    p.i ? `<option value="${i}">${p.name}</option>` : `<option value="" disabled>${p.name}</option>`
  ).join('');
}

// Stage E.8: oscillators, noise+arpeggio, and envelope+LFO are each two
// .instr-sub sections stacked inside one .instr-card (rather than four
// separate cards) so the pairing holds together as one .instr-grid item --
// Ryan asked for Osc1 above Osc2, Arpeggio under Noise, LFO under Envelope.
// That leaves exactly four .instr-card elements (these three plus FX), which
// Stage E.11's fixed-4-column .instr-grid (screen.css) relies on to lay all
// four out in one row instead of wrapping.
export function initInstrumentPanel() {
  $('instrument-panel').classList.remove('wip');
  $('instrument-panel').innerHTML = `
    <div class="instr-header">
      <h3 title="The sound one channel plays. Every note in that channel's patterns uses these settings — one instrument per channel, all the way through the song.">Instrument</h3>
      <label title="Which channel's instrument these controls edit. Clicking any cell in the tracker selects that channel too.">Channel <select id="instr-channel"></select></label>
      <select id="instr-preset" title="Load one of SoundBox's ready-made instruments into this channel, as a starting point to tweak. Overwrites every setting below.">
      </select>
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

  $('instr-preset').innerHTML = presetOptionsHTML();
  $('instr-preset').onchange = () => {
    const idx = $('instr-preset').value;
    if (idx === '') return;
    const src = window.gInstrumentPresets[+idx].i;
    for (let j = 0; j < src.length; j++) currentInstr().i[j] = src[j];
    refreshInstrumentPanel();
  };

  $('instr-copy').onclick = () => { instrClipboard = currentInstr().i.slice(); };
  $('instr-paste').onclick = () => {
    if (!instrClipboard) return;
    currentInstr().i = instrClipboard.slice();
    refreshInstrumentPanel();
  };

  $('instr-channel').onchange = () => {
    state.selInstrument = +$('instr-channel').value;
    refreshInstrumentPanel();
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
