// Instrument panel: oscillator 1/2, noise, envelope, arpeggio, FX and LFO
// controls for the currently selected channel.
//
// TWO ARRAYS, NOT ONE (v2)
// ------------------------
// v1 kept all 28 parameters in one array per channel. v2 splits them: the 17
// that describe a *voice* live in a song-level pool (song.instruments), and
// the 13 that describe the *mixer strip* stay on the channel
// (song.channels[c].fx). A voice is snapshotted at note-on, so a note keeps
// the sound it started with; a strip parameter is read every row, so an
// effect command can sweep it while notes play.
//
// Every control names a parameter address instead of a bare index -- V(n) for
// a voice parameter, X(n) for a strip one -- and getParam/setInstrProp route
// it. The cards are grouped to match: Oscillators, Noise/Arpeggio and Envelope
// are the voice; LFO and FX are the strip.
//
// TWO SELECTORS
// -------------
// Because the two halves are addressed separately, the header has two
// selectors, and they answer different questions:
//
//   Channel  which channel's *strip* the FX controls edit (state.selInstrument,
//            shared with the tracker -- clicking any cell moves it)
//   Voice    which pool entry the *voice* controls edit (state.selVoice)
//
// Focusing a channel pulls Voice onto that channel's default, so the ordinary
// case is still one click. Changing Voice by hand does not change what the
// channel plays; the Use button does that. Keeping those apart is what lets
// one voice be edited while another is sounding, and lets several channels
// share a voice without editing one silently changing the others by surprise.
//
// While an effect cell is selected (tracker.js's activeFxCell()), a write to
// a *strip* control is mirrored into that cell as well as into the live strip
// (see setInstrProp), and the controls display the cell's stored value on top
// of the strip's (see previewInstr). Voice controls are not mirrored: v2
// snapshots a voice at note-on, so an effect command that wrote one would
// change nothing.
//
// Instrument copy/paste uses a module-local clipboard, leaving state.clipboard
// to the pattern clipboard so the two can't collide.

import * as engine from '../engine2.js';
import { state } from '../state.js';
import { svgIcon } from '../icons.js';
import { activeFxCell } from './tracker.js';
import { syncJammer } from './keyboard.js';
import { getAccent } from '../theme.js';
import { render as renderPianoRoll } from './pianoroll.js';
import { v2Presets } from '../presets2.js';

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
// A parameter address. `fx` says which of the two arrays it lives in; `i` is
// its index there. Every control names one of these instead of a bare number,
// which is what keeps the routing in one place.
const V = i => ({ fx: false, i });   // a voice parameter, song.instruments[n]
const X = i => ({ fx: true, i });    // a strip parameter, channel.fx

const SLIDERS = {
  osc1_vol: { prop: V(engine.OSC1_VOL), min: 0, max: 255 },
  osc1_semi: { prop: V(engine.OSC1_SEMI), min: 92, max: 164 },
  osc1_xenv: { prop: V(engine.OSC1_XENV), min: 0, max: 255 },
  osc2_vol: { prop: V(engine.OSC2_VOL), min: 0, max: 255 },
  osc2_semi: { prop: V(engine.OSC2_SEMI), min: 92, max: 164 },
  osc2_det: { prop: V(engine.OSC2_DETUNE), min: 0, max: 255, nonLinear: true },
  osc2_xenv: { prop: V(engine.OSC2_XENV), min: 0, max: 255 },
  noise_vol: { prop: V(engine.NOISE_VOL), min: 0, max: 255 },
  env_att: { prop: V(engine.ENV_ATTACK), min: 0, max: 255 },
  env_dec: { prop: V(engine.ENV_DECAY), min: 0, max: 255 },
  env_sus: { prop: V(engine.ENV_SUSTAIN_LEVEL), min: 0, max: 255 },
  env_rel: { prop: V(engine.ENV_RELEASE), min: 0, max: 255 },
  env_decay: { prop: V(engine.ENV_EXP_DECAY), min: 0, max: 255 },
  arp_speed: { prop: V(engine.ARP_SPEED), min: 0, max: 7 },
  lfo_amt: { prop: X(engine.LFO_AMT), min: 0, max: 255 },
  lfo_freq: { prop: X(engine.LFO_FREQ), min: 0, max: 16 },
  fx_freq: { prop: X(engine.FX_FREQ), min: 0, max: 255, nonLinear: true },
  fx_res: { prop: X(engine.FX_RESONANCE), min: 0, max: 254 },
  fx_dist: { prop: X(engine.FX_DIST), min: 0, max: 255, nonLinear: true },
  fx_drive: { prop: X(engine.FX_DRIVE), min: 0, max: 255 },
  fx_pan_amt: { prop: X(engine.FX_PAN_AMT), min: 0, max: 255 },
  fx_pan_freq: { prop: X(engine.FX_PAN_FREQ), min: 0, max: 16 },
  fx_dly_amt: { prop: X(engine.FX_DELAY_AMT), min: 0, max: 255 },
  fx_dly_time: { prop: X(engine.FX_DELAY_TIME), min: 0, max: 16 },
};

let instrClipboard = null;
// Which channel the panel last drew, so refreshInstrumentPanel can tell a
// change of focus from an ordinary repaint.
let lastChannel = -1;

const currentChannel = () => state.song.channels[state.selInstrument];

// The voice the panel is editing -- state.selVoice, not the focused channel's
// default. The two are usually the same, because focusing a channel follows
// its default (see refreshInstrumentPanel), but they can be pulled apart to
// edit one voice while another is playing.
function currentVoice() {
  return state.song.instruments[state.selVoice] || state.song.instruments[0];
}

const arrayFor = addr => (addr.fx ? currentChannel().fx : currentVoice());

function getParam(addr) { return arrayFor(addr)[addr.i]; }

// If an effect cell is selected, a *strip* write is mirrored into that cell as
// well as into the live strip. A voice write is not: v2 snapshots a voice at
// note-on, so a command that wrote one would have nothing to change.
function setInstrProp(addr, value) {
  arrayFor(addr)[addr.i] = value;
  if (addr.fx) {
    const cell = activeFxCell();
    if (cell) cell.set(addr.i, value);
  }
  $('instr-preset').value = '';
  syncJammer();
  // The piano roll draws each note as long as it sounds, so an envelope edit
  // must repaint it. A no-op in the tracker view.
  if (!addr.fx && addr.i >= engine.ENV_ATTACK && addr.i <= engine.ENV_RELEASE) renderPianoRoll();
}

// What the jammer should play: the voice being edited and the focused
// channel's strip, unless an effect cell is selected, in which case that
// cell's stored value previews on top of the one strip parameter it targets.
// panels/keyboard.js reads this, so the live preview hears the same settings
// these controls show.
//
// Both halves go across as themselves now. The jammer runs the same ADSR the
// offline players do, so a preview holds a note under the key and releases it
// on key-up, exactly as the song will -- there is no v1 bridge left here.
export function previewInstr() {
  const fx = currentChannel().fx.slice();
  const cell = activeFxCell();
  if (cell && cell.cmd >= engine.PARAM) {
    const idx = cell.cmd - engine.PARAM;
    if (idx < engine.NUM_FX_PARAMS) fx[idx] = cell.val;
  }
  return { voice: currentVoice().slice(), fx };
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

function refreshSlider(id, def) {
  const el = $(id);
  const value = getParam(def.prop);
  el.value = def.nonLinear
    ? Math.round(1000 * Math.sqrt(Math.min(1, Math.max(0, (value - def.min) / (def.max - def.min)))))
    : value;
  el.nextElementSibling.textContent = value;
  paintFill(el);
}

// The arpeggio's two notes share one byte (ARP_CHORD: high nibble = note 1, low
// nibble = note 2), so they can't go through SLIDERS' one-slider-one-property
// mapping and are bound as a special case.
const ARP = V(engine.ARP_CHORD);

function bindArpNotes() {
  $('arp_note1').min = $('arp_note2').min = 0;
  $('arp_note1').max = $('arp_note2').max = 12;
  $('arp_note1').oninput = () => {
    const v = +$('arp_note1').value;
    setInstrProp(ARP, (getParam(ARP) & 15) | (v << 4));
    $('arp_note1').nextElementSibling.textContent = v;
    paintFill($('arp_note1'));
  };
  $('arp_note2').oninput = () => {
    const v = +$('arp_note2').value;
    setInstrProp(ARP, (getParam(ARP) & 240) | v);
    $('arp_note2').nextElementSibling.textContent = v;
    paintFill($('arp_note2'));
  };
}

function refreshArpNotes() {
  const chord = getParam(ARP);
  $('arp_note1').value = chord >> 4;
  $('arp_note1').nextElementSibling.textContent = chord >> 4;
  paintFill($('arp_note1'));
  $('arp_note2').value = chord & 15;
  $('arp_note2').nextElementSibling.textContent = chord & 15;
  paintFill($('arp_note2'));
}

// The upstream presets, converted once at first use (presets2.js). Cached
// because the conversion reads a global that never changes after boot.
let presetCache = null;
const presets = () => (presetCache || (presetCache = v2Presets()));

function presetOptionsHTML() {
  return '<option value="">(select a preset)</option>' + presets().map((p, i) =>
    p.voice ? `<option value="${i}">${p.name}</option>` : `<option value="" disabled>${p.name}</option>`
  ).join('');
}

// Load a converted preset into the voice being edited and the focused
// channel's strip. Both halves, because a preset describes a whole sound and
// several of them lean hard on their filter settings.
function loadPreset(preset) {
  const voice = currentVoice();
  for (let j = 0; j < voice.length; j++) voice[j] = preset.voice[j];
  currentChannel().fx = preset.fx.slice();
  // Name the voice after the preset, unless it has been named already -- the
  // pool is far easier to read that way and there is nothing else to call it.
  if (!state.song.instrumentNames[state.selVoice]) {
    state.song.instrumentNames[state.selVoice] = preset.name;
  }
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
      <h3 title="A voice from the song's instrument pool, and the mixer strip of one channel. The two are separate in v2: a voice is snapshotted when a note starts, so several channels can play the same one and a note can name a different one; the strip belongs to the channel and every note on it goes through.">Instrument</h3>
      <label title="Which channel's mixer strip these FX controls edit. Clicking any cell in the tracker selects that channel too.">Channel <select id="instr-channel"></select></label>
      <label title="Which voice from the song's pool the Oscillator, Noise, Arpeggio and Envelope controls edit. Changing this does not change what the channel plays — use the button beside it for that.">Voice <select id="instr-pool"></select></label>
      <input id="instr-name" type="text" maxlength="20" placeholder="name"
             title="A name for this voice, so the pool is readable. Editor only: nothing in the player reads it, and a song whose voices are all unnamed costs no extra bytes when exported.">
      <button id="instr-assign" type="button" title="Make this voice the one the focused channel plays by default. Notes can still name a different one in the tracker's Ins column.">Use</button>
      <button id="instr-add" type="button" title="Add a copy of this voice to the pool, to edit into a variation">+</button>
      <button id="instr-del" type="button" title="Remove this voice from the pool. Refused while any note or channel still names it.">−</button>
      <select id="instr-preset" title="Load one of SoundBox's ready-made instruments into this voice and the focused channel's strip. Overwrites every setting below.">
      </select>
      <button id="instr-copy" type="button" title="Copy this voice and the channel's strip, to paste onto another channel">${svgIcon('copy')}</button>
      <button id="instr-paste" type="button" title="Overwrite this voice and the channel's strip with the copied pair">${svgIcon('paste')}</button>
    </div>
    <div class="instr-grid">
      <div class="instr-card instr-card-voice">
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
      <div class="instr-card instr-card-voice">
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
      <div class="instr-card instr-card-voice">
        <div class="instr-sub">
          <h4 title="The shape of a note's volume over time: fade in (Att), fall to the sustain level (Dec, Sus), then fade out when the note is released (Rel). A note with Sus above 0 holds until something releases it — a note-off, or a GAT command. A note with Sus at 0 dies away on its own, which is what a drum wants.">Envelope</h4>
          ${sliderRow('env_att', 'Att', 'Fade-in time. 0 starts instantly (percussive); high values swell in, for pads and strings.')}
          ${sliderRow('env_dec', 'Dec', 'How long it takes to fall from full volume to the sustain level after the fade-in.')}
          ${sliderRow('env_sus', 'Sus', 'The level the note holds at once the decay is done. 0 means it dies away and needs no note-off — a drum. Above 0 it rings until a note-off or a GAT command releases it.')}
          ${sliderRow('env_rel', 'Rel', 'Fade-out time after the note is released — the tail. This is what makes a sound short and dry or long and ringing.')}
          ${sliderRow('env_decay', 'Exp', 'Bends both the decay and the fade-out from a straight line into an exponential drop: plucky and front-loaded instead of an even fade.')}
        </div>
      </div>
      <div class="instr-card instr-card-strip">
        <div class="instr-sub">
          <h4 title="A slow oscillator that sweeps the FX filter cutoff up and down for wah and wobble. It does nothing until FX freq modulation below is ticked.">LFO</h4>
          <div class="ctl-row" title="Shape of the sweep: sine wobbles smoothly, square jumps between two cutoffs, saw ramps and snaps back."><label>Wave</label>${iconGroupHTML('lfo-wave', WAVE_ICONS)}</div>
          ${sliderRow('lfo_amt', 'Amt', 'How far the sweep pushes the filter cutoff. 0 is no movement at all.')}
          ${sliderRow('lfo_freq', 'Freq', 'How fast it sweeps, relative to the row length — so it stays in step with the tempo. Low values are one slow wave over several rows.')}
          <label class="ctl-check" title="Route the LFO to the FX filter cutoff. Nothing the LFO is set to does anything until this is on — it is the LFO's on switch."><input id="lfo_fxfreq" type="checkbox"> FX freq modulation</label>
        </div>
      </div>
      <div class="instr-card instr-card-fx instr-card-strip">
        <h4 title="Applied to the whole channel after the notes are mixed, in this order: filter, distortion, drive, panning, delay. An effect column in the tracker can change any of these mid-pattern with a PARAM command.">FX</h4>
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
  bindIconGroup('osc1-wave', V(engine.OSC1_WAVEFORM));
  bindIconGroup('osc2-wave', V(engine.OSC2_WAVEFORM));
  bindIconGroup('lfo-wave', X(engine.LFO_WAVEFORM));
  bindIconGroup('fx-filter', X(engine.FX_FILTER));

  $('lfo_fxfreq').onchange = () => setInstrProp(X(engine.LFO_FX_FREQ), $('lfo_fxfreq').checked ? 1 : 0);

  $('instr-preset').innerHTML = presetOptionsHTML();
  $('instr-preset').onchange = () => {
    const idx = $('instr-preset').value;
    if (idx === '') return;
    loadPreset(presets()[+idx]);
    refreshInstrumentPanel();
    $('instr-preset').blur();
  };

  // Copy/paste moves the voice *and* the strip together, because that pair is
  // what "this channel's sound" means to the person clicking the button. The
  // voice is copied by value into the target's own pool entry rather than
  // shared, so pasting onto a second channel does not silently link the two.
  $('instr-copy').onclick = () => {
    instrClipboard = { voice: currentVoice().slice(), fx: currentChannel().fx.slice() };
  };
  $('instr-paste').onclick = () => {
    if (!instrClipboard) return;
    const voice = currentVoice();
    for (let j = 0; j < voice.length; j++) voice[j] = instrClipboard.voice[j];
    currentChannel().fx = instrClipboard.fx.slice();
    refreshInstrumentPanel();
  };

  $('instr-channel').onchange = () => {
    state.selInstrument = +$('instr-channel').value;
    refreshInstrumentPanel();
    $('instr-channel').blur();
  };

  // --- the instrument pool -------------------------------------------------
  $('instr-pool').onchange = () => {
    state.selVoice = +$('instr-pool').value;
    refreshInstrumentPanel();
    $('instr-pool').blur();
  };

  // Named live rather than on blur, so the pool list reads back what is being
  // typed. A name is not song content the player reads, so it deliberately
  // does not go through setInstrProp's jammer resync.
  $('instr-name').oninput = () => {
    state.song.instrumentNames[state.selVoice] = $('instr-name').value;
    refreshPoolList();
    state.notify && state.notify();
  };

  $('instr-assign').onclick = () => {
    currentChannel().ins = state.selVoice;
    refreshInstrumentPanel();
    state.notify && state.notify();
  };

  $('instr-add').onclick = () => {
    // A copy of the voice on screen, not a blank one: a variation of what you
    // are already hearing is what this button is nearly always for.
    const name = state.song.instrumentNames[state.selVoice] || '';
    const i = engine.addInstrument(state.song, currentVoice(), name ? name + ' 2' : '');
    if (i < 0) { flashInstr(`The pool is full (${engine.MAX_INSTRUMENTS} voices)`); return; }
    state.selVoice = i;
    refreshInstrumentPanel();
    state.notify && state.notify();
  };

  $('instr-del').onclick = () => {
    // engine2 refuses while anything still names it, and renumbers the
    // references above it when it does remove -- so the panel only has to
    // report which of those happened.
    if (!engine.removeInstrument(state.song, state.selVoice)) {
      flashInstr(state.song.instruments.length < 2
        ? 'A song needs at least one voice'
        : 'Still in use by a note or a channel');
      return;
    }
    state.selVoice = Math.min(state.selVoice, state.song.instruments.length - 1);
    refreshInstrumentPanel();
    state.notify && state.notify();
  };
}

// A short-lived message beside the pool controls, for the two things that can
// be refused. Same idea as the tracker's flashFeedback.
function flashInstr(message) {
  const el = $('instr-name');
  if (!el) return;
  const was = el.placeholder;
  el.placeholder = message;
  el.classList.add('refused');
  setTimeout(() => { el.placeholder = was; el.classList.remove('refused'); }, 1600);
}

// The pool <select>, as "00 Name" rows. Rebuilt whenever the pool or a name
// changes; kept separate from the full refresh so typing a name does not
// rebuild every slider.
function refreshPoolList() {
  const sel = $('instr-pool');
  if (!sel) return;
  const playing = currentChannel().ins;
  sel.innerHTML = state.song.instruments.map((_, i) => {
    const name = state.song.instrumentNames[i] || '';
    // The channel's own default is marked, so the two selectors can be read
    // against each other at a glance.
    const mark = i === playing ? ' ▸' : '';
    return `<option value="${i}">${i.toString(16).toUpperCase().padStart(2, '0')}${mark} ${name}</option>`;
  }).join('');
  sel.value = state.selVoice;
}

export function refreshInstrumentPanel() {
  const sel = $('instr-channel');
  if (sel.options.length !== engine.MAX_CHANNELS) {
    sel.innerHTML = Array.from({ length: engine.MAX_CHANNELS }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
  }
  if (state.selInstrument < 0 || state.selInstrument >= engine.MAX_CHANNELS) state.selInstrument = 0;
  sel.value = state.selInstrument;

  // Focusing a different channel pulls the voice selector onto that channel's
  // default, so clicking a pattern column lands on the sound it plays without
  // a second click. Only on an actual change of channel: doing it on every
  // refresh would fight a deliberate pick of another voice.
  if (lastChannel !== state.selInstrument) {
    lastChannel = state.selInstrument;
    state.selVoice = currentChannel().ins;
  }
  if (state.selVoice < 0 || state.selVoice >= state.song.instruments.length) state.selVoice = 0;
  refreshPoolList();
  if (document.activeElement !== $('instr-name')) {
    $('instr-name').value = state.song.instrumentNames[state.selVoice] || '';
  }
  // Assigning the voice a channel already plays would do nothing.
  $('instr-assign').disabled = currentChannel().ins === state.selVoice;

  setActiveIcon('osc1-wave', getParam(V(engine.OSC1_WAVEFORM)));
  setActiveIcon('osc2-wave', getParam(V(engine.OSC2_WAVEFORM)));
  setActiveIcon('lfo-wave', getParam(X(engine.LFO_WAVEFORM)));
  setActiveIcon('fx-filter', getParam(X(engine.FX_FILTER)));

  for (const [id, def] of Object.entries(SLIDERS)) refreshSlider(id, def);
  refreshArpNotes();

  $('lfo_fxfreq').checked = !!getParam(X(engine.LFO_FX_FREQ));
}
