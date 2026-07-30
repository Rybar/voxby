// Keyboard panel: an on-screen piano plus live audio preview. One element per
// key with data-octave/data-offset attributes, black and white keys drawn in CSS
// and laid out as percentages of the panel's width so they always fill it.
//
// The piano spans the engine's entire playable range at once -- octaves 1-8, 56
// white + 40 black keys -- so every note is one click away without touching the
// octave selector. Each key's note is therefore absolute (its position already
// encodes its octave), not relative to state.octave; the octave selector's only
// job is re-anchoring the small per-key .kb-label spans that say which physical
// keyboard key plays that note right now, since the physical keyboard only
// covers ~2.4 octaves at a time. A key can show two labels when two physical
// keys reach the same note (see BOTTOM_ROW below).
//
// Keys light up from three independent sources -- mouse, physical key, song
// playback -- and any of them can claim the same key at once without one
// clearing another's still-held highlight; see litBy/setLit below.
//
// Owns the CJammer instance (jammer.js, a vendored classic script/global, same
// bridge direction as player.js's CPlayer in main.js) used for live note
// preview: clicking an on-screen key, or pressing one of tracker.js's NOTE_KEYS
// while the pattern/fx grid has focus, plays the note immediately instead of
// only writing it silently into the pattern. syncJammer() is called from
// main.js's refresh() so the jammer never goes stale on the currently *previewed*
// instrument (panels/instrument.js's previewInstrI() -- the live instrument, or
// an FX cell's stored value while one is selected) or the current tempo.
// getJammer() exposes the instance so main.js's scope loop can read its live
// waveform.
//
// Imports flow one way: keyboard -> instrument -> tracker, plus a direct
// keyboard -> tracker edge. tracker.js reaches this module's relative-offset
// preview through state.previewNote -- a callback field, like
// state.notify/state.requestStop -- rather than importing it, since tracker.js ->
// keyboard.js would close a cycle. keyboard.js importing tracker.js is fine
// (tracker.js imports nothing from here), and that is what lets an on-screen key
// click write into the pattern grid and not merely preview. The playback
// highlighting and the pie's chord shadow use the same callback-field trick in
// the other direction (state.highlightNotes, state.shadowNotes, both set by
// main.js).
//
// There is no MIDI input: SoundBox's was never separable from its old UI, and
// nothing else here depends on it.

import * as engine from '../engine.js';
import { state, savePrefs } from '../state.js';
import { audioContext } from '../audio.js';
import { previewInstrI } from './instrument.js';
import { noteKeys, enterNoteAtCursor, chordNotesFor } from './tracker.js';
import { SCALES, PITCH_NAMES, degreeOfPitch } from '../scales.js';
import { LAYOUTS, LAYOUT_TABLES, charFor, detectLayout } from '../layouts.js';
import { typingInField } from '../focus.js';

const $ = id => document.getElementById(id);

// The engine's playable octave range, and state.octave's own clamp bounds:
// 8 octaves * (7 white + 5 black) = 96 keys.
const OCTAVE_MIN = 1, OCTAVE_MAX = 8;
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
// [index into WHITE_OFFSETS the black key sits after, semitone offset], one
// octave's worth; repeated at every octave below.
const BLACK_KEYS = [[0, 1], [1, 3], [3, 6], [4, 8], [5, 10]];
const WHITE_PER_OCTAVE = WHITE_OFFSETS.length;
const OCTAVES = OCTAVE_MAX - OCTAVE_MIN + 1;
const WHITE_COUNT = WHITE_PER_OCTAVE * OCTAVES;
const WHITE_W = 100 / WHITE_COUNT; // percent of .kb-piano's width
const BLACK_W = WHITE_W * 0.62;

// The scale/chord controls live in this panel's header because everything there
// answers "what does a keypress play", which is this panel's job, and the octave
// selector beside them is the other half of the same question. The mapping itself
// lives in scales.js and is reached through tracker.js's noteKeys(); since
// refreshKeyboardPanel() derives its key labels *from* that map rather than a
// hardcoded table, the piano relabels itself when the scale or its root changes.
//
// tracker.js's chromatic NOTE_KEYS has two overlapping physical-key rows: a
// bottom row (ZXCVB... plus a few punctuation keys) and a QWERTY row one octave
// up. They overlap across a 5-note span (offsets 12-16) where both a bottom-row
// and a QWERTY-row key play the same note -- Comma and KeyQ are both offset 12.
// This set says which codes belong to the bottom row, so a shared key can show
// both labels instead of one hiding the other (see refreshKeyboardPanel).
const BOTTOM_ROW = new Set([
  'KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM',
  'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash',
]);

// Which characters the physical note keys actually print, for the .kb-label
// hints. Note entry is keyed by KeyboardEvent.code -- a physical position, so
// the fingering is identical on every layout (see layouts.js) -- and only the
// printed labels need translating.
//
// `detected` is the browser's own report of the live layout (async, so a first
// paint can happen before it lands -- hence the refresh when it resolves in
// initKeyboardPanel). state.kbLayout picks between it and the static tables.
let detected = null;
function layoutTable() {
  return state.kbLayout === 'auto' ? detected : LAYOUT_TABLES[state.kbLayout];
}
const codeChar = code => charFor(code, layoutTable());

// Keyed by octaveK*12+offsetInOctave, populated once in initKeyboardPanel.
// highlightPlaybackNotes runs on every animation-frame tick while a song plays
// (see main.js), and a querySelector per note per frame is the one cost here
// worth cutting -- this makes it an O(1) Map lookup. labelSpans (each key's two
// .kb-label <span>s) is cached the same way for refreshKeyboardPanel.
const keyIndex = new Map();
const labelSpans = new Map();
function keyEl(octaveK, offsetInOctave) {
  return keyIndex.get(octaveK * 12 + offsetInOctave);
}

// --- highlighting: three independent sources (mouse click, physical
// keyboard, song playback) can each want a key lit at once. A plain
// classList toggle would have one source's "off" wipe out another's still-
// held "on" (e.g. releasing the mouse over a key you're also physically
// holding down would go dark). litBy tracks, per element, which sources
// currently claim it; the class stays on as long as any source does. ---
const litBy = new Map();
function setLit(el, source, on) {
  if (!el) return;
  let set = litBy.get(el);
  if (on) {
    if (!set) litBy.set(el, set = new Set());
    set.add(source);
    el.classList.add('active');
  } else if (set) {
    set.delete(source);
    if (set.size === 0) { litBy.delete(el); el.classList.remove('active'); }
  }
}

let jammer = null;
function ensureJammer() {
  if (!jammer) { jammer = new CJammer(); jammer.start(audioContext); }
  return jammer;
}

// Exposes the jammer instance, once one exists (i.e. after the first note
// preview), to main.js's scope loop so panels/scope.js can visualize live
// keyboard preview alongside song playback. Deliberately doesn't force-create
// one: before a note has been played there is nothing to visualize.
export function getJammer() {
  return jammer;
}

// Called from main.js's refresh() after every edit/load so the jammer's
// snapshot instrument/tempo never goes stale.
export function syncJammer() {
  ensureJammer().updateInstr(previewInstrI());
  jammer.updateRowLen(state.song.rowLen);
}

// Takes a raw key/piano offset *relative to the selected octave* (0 =
// state.octave's first key) and returns the actual note number in SoundBox's
// note space. Registered on state.previewNote by main.js so tracker.js's
// physical-keyboard entry can call it -- and reuse the returned note for its
// pattern-grid write -- without importing this module.
export function previewNote(offset) {
  const note = offset + state.octave * 12 + engine.NOTE_OFFSET;
  ensureJammer().addNote(note);
  return note;
}

// On-screen full-piano key -> absolute note (the key's own octave, not
// state.octave -- see this file's top comment). Plays through the jammer
// and, in pattern edit mode, writes into the pattern grid at the cursor.
function previewAndEnter(octaveK, offsetInOctave) {
  const note = offsetInOctave + octaveK * 12 + engine.NOTE_OFFSET;
  ensureJammer().addNote(note);
  enterNoteAtCursor(note);
}

// Light up the on-screen key(s) for whatever notes tracker.js's followPlayback
// says are currently sounding. Registered on
// state.highlightNotes by main.js. Diffs against the previous call's set so
// a note that's still sounding doesn't flicker off and back on.
let playbackLit = new Set();
export function highlightPlaybackNotes(notes) {
  const next = new Set();
  for (const note of notes) {
    const raw = note - engine.NOTE_OFFSET;
    const oct = Math.floor(raw / 12), offset = raw - oct * 12;
    if (oct < OCTAVE_MIN || oct > OCTAVE_MAX) continue;
    const el = keyEl(oct, offset);
    if (el) next.add(el);
  }
  for (const el of playbackLit) if (!next.has(el)) setLit(el, 'play', false);
  for (const el of next) if (!playbackLit.has(el)) setLit(el, 'play', true);
  playbackLit = next;
}

// --- chord shadow: hovering a key in chord mode outlines every
// key that keypress would actually write, so a chord can be read off the
// piano before committing to it. Deliberately *not* routed through setLit
// above -- a shadow is a different statement than "this key is sounding",
// and drawing it as its own class (an outline rather than a fill, see
// screen.css) keeps all three signals -- in-scale tint, chord shadow, key
// lit -- legible at once on the same key. With no scale set there's no
// quality to infer from one key, so chordNotesFor returns just that note and
// nothing is shadowed until a digit names the chord. ---
let shadowLit = [];
function clearShadow() {
  for (const el of shadowLit) el.classList.remove('kb-shadow');
  shadowLit = [];
}
function setShadow(notes) {
  clearShadow();
  for (const note of notes) {
    const raw = note - engine.NOTE_OFFSET, oct = Math.floor(raw / 12);
    const el = keyEl(oct, raw - oct * 12);
    if (el) { el.classList.add('kb-shadow'); shadowLit.push(el); }
  }
}
function showShadow(octaveK, offsetInOctave) {
  clearShadow();
  if (!state.chordOn) return;
  const notes = chordNotesFor(offsetInOctave + octaveK * 12 + engine.NOTE_OFFSET);
  if (notes.length < 2) return;
  setShadow(notes);
}

// The same outline, driven by an explicit note list instead of a hovered key --
// registered on state.shadowNotes by main.js so the entry pie (panels/pie.js)
// can show what the wedge under the cursor would write. No `length < 2` guard
// here, unlike the hover path above: a single note is a deliberate pick in the
// pie, and worth showing since it says which octave you are about to land in,
// whereas on hover it would shadow every key the mouse crossed in chromatic
// mode.
export function shadowNotes(notes) {
  setShadow(notes);
}

// Matches the guard tracker.js's onKeyDown uses (see focus.js): a focused
// instrument slider or checkbox must not stop the physical keyboard from playing
// and highlighting notes -- only a field you are actually typing into does.
function isNoteEntryActive() {
  return !typingInField() && (state.editMode === 'pattern' || state.editMode === 'fx');
}

// Physical-keyboard presses light up the on-screen key they play. Tracked per
// e.code rather than per note, so held chords each get their own key lit and
// release the right one on keyup even if the octave changed in between.
const physicalLitByCode = new Map();
function onPhysicalKeyDown(e) {
  if (physicalLitByCode.has(e.code) || !isNoteEntryActive()) return;
  const n = noteKeys()[e.code];
  if (n === undefined) return;
  const total = n + state.octave * 12;
  const el = keyEl(Math.floor(total / 12), total - Math.floor(total / 12) * 12);
  if (el) { physicalLitByCode.set(e.code, el); setLit(el, 'key', true); }
}
function onPhysicalKeyUp(e) {
  const el = physicalLitByCode.get(e.code);
  if (el) { physicalLitByCode.delete(e.code); setLit(el, 'key', false); }
}

export function initKeyboardPanel() {
  $('keyboard-panel').classList.remove('wip');
  $('keyboard-panel').innerHTML = `
    <div class="row kb-header">
      <h3 title="Note entry. Anything you play here — piano keys, computer keys, the entry pie — is heard live and written into the pattern cell the tracker cursor is on.">Keyboard</h3>
      <label title="Which characters your keyboard prints, for the key hints on the piano below. Auto asks the browser. The notes themselves are tied to physical key positions, so the fingering is the same on every layout — only the labels change.">Keys
        <select id="kb-layout">${LAYOUTS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
      <label id="kb-scale-label" title="Remap the computer keyboard to two straight rows of in-scale notes: Z-M and Q-P. The sharp keys (S D G H J / 2 3 5 6 7) go unused — that is the point.">Scale
        <select id="kb-scale">${SCALES.map(([name], i) => `<option value="${i}">${name}</option>`).join('')}</select></label>
      <span class="kb-root" id="kb-root-group" title="Transpose the scale in half steps. Independent of the octave buttons, which keep moving the whole key set.">Root
        <button id="kb-root-down" type="button" title="Move the scale's root down a half step">-</button>
        <span class="mono" id="kb-root" title="The scale's root note — which note the Z and Q keys land on"></span>
        <button id="kb-root-up" type="button" title="Move the scale's root up a half step">+</button></span>
      <label class="kb-chord-toggle" title="One keypress writes a chord across the pattern row's 4 note columns. With a scale set, the quality comes from the scale; otherwise press a digit right after the note (Q then 1 = Cmaj7, W then 6 = D6).">
        <input id="kb-chord" type="checkbox"> Chord</label>
      <span class="kb-voicing" id="kb-voicing" title="Which chord tones get written. Switch the root off for a rootless voicing — the rest pack left into columns 0-2.">
        ${['R', '3', '5', '7'].map((label, i) =>
          `<label><input type="checkbox" class="kb-tone" data-tone="${i}"> ${label}</label>`).join('')}</span>
      <span class="mono kb-chord-name" id="kb-chord-name" title="The chord the last note you played spells out, given the scale and voicing set here"></span>
      <div class="spacer"></div>
      <label title="Rows the pattern cursor moves after entering a note — a tracker's edit step. 1 = the next row, 0 = stay put, 4 = a beat at a time. Applies to typed notes, on-screen piano clicks and the double-click entry pie alike.">Step
        <input id="kb-step" type="number" min="0" max="16"></label>
      <button id="kb-oct-down" type="button" title="Move the playable key range down an octave (&lt; or -)">-</button>
      <span class="mono" id="kb-octave" title="Octave the bottom-left computer key (Z) currently plays"></span>
      <button id="kb-oct-up" type="button" title="Move the playable key range up an octave (&gt; or =)">+</button>
    </div>
    <!-- One tip on the piano rather than 96 on the individual keys: each key
         already labels itself with its note and computer key, so a per-key
         tooltip would only repeat what is printed on it. -->
    <div class="kb-piano" id="kb-piano" title="Click a key to hear it and write it at the tracker cursor. The labels on each key are the computer key that plays it. Hovering outlines the chord that key would write; the lit keys during playback are the notes currently sounding."></div>`;

  let html = '';
  for (let oct = OCTAVE_MIN; oct <= OCTAVE_MAX; oct++) {
    const base = (oct - OCTAVE_MIN) * WHITE_PER_OCTAVE;
    WHITE_OFFSETS.forEach((offset, i) => {
      html += `<div class="kb-white" data-octave="${oct}" data-offset="${offset}" `
        + `style="left:${(base + i) * WHITE_W}%;width:${WHITE_W}%">`
        + `<span class="kb-label"><span></span><span></span></span></div>`;
    });
  }
  for (let oct = OCTAVE_MIN; oct <= OCTAVE_MAX; oct++) {
    const base = (oct - OCTAVE_MIN) * WHITE_PER_OCTAVE;
    BLACK_KEYS.forEach(([afterIdx, offset]) => {
      const left = (base + afterIdx + 1) * WHITE_W - BLACK_W / 2;
      html += `<div class="kb-black" data-octave="${oct}" data-offset="${offset}" `
        + `style="left:${left}%;width:${BLACK_W}%">`
        + `<span class="kb-label"><span></span><span></span></span></div>`;
    });
  }
  const piano = $('kb-piano');
  piano.innerHTML = html;
  keyIndex.clear();
  labelSpans.clear();
  piano.querySelectorAll('[data-offset]').forEach(el => {
    keyIndex.set(+el.dataset.octave * 12 + +el.dataset.offset, el);
    labelSpans.set(el, el.querySelectorAll('.kb-label span'));
  });

  let mouseLit = null;
  piano.addEventListener('mousedown', e => {
    const key = e.target.closest('[data-offset]');
    if (!key) return;
    previewAndEnter(+key.dataset.octave, +key.dataset.offset);
    mouseLit = key;
    setLit(key, 'click', true);
  });
  document.addEventListener('mouseup', () => {
    if (mouseLit) { setLit(mouseLit, 'click', false); mouseLit = null; }
  });
  piano.addEventListener('mouseover', e => {
    const key = e.target.closest('[data-offset]');
    if (key) showShadow(+key.dataset.octave, +key.dataset.offset);
  });
  piano.addEventListener('mouseleave', clearShadow);
  document.addEventListener('keydown', onPhysicalKeyDown);
  document.addEventListener('keyup', onPhysicalKeyUp);

  $('kb-oct-down').onclick = () => { state.octave = Math.max(1, state.octave - 1); refreshKeyboardPanel(); state.notify && state.notify(); };
  $('kb-oct-up').onclick = () => { state.octave = Math.min(8, state.octave + 1); refreshKeyboardPanel(); state.notify && state.notify(); };

  // The note-input controls. All four write to state (persisted as preferences,
  // not song data -- see state.js) and re-derive the piano; nothing here touches
  // the song, so none of it marks it dirty.
  const changed = () => { clearShadow(); savePrefs(); refreshKeyboardPanel(); state.notify && state.notify(); };
  $('kb-layout').onchange = () => { state.kbLayout = $('kb-layout').value; changed(); };
  $('kb-scale').onchange = () => { state.scaleMode = +$('kb-scale').value; changed(); };
  $('kb-root-down').onclick = () => { state.scaleRoot = (state.scaleRoot + 11) % 12; changed(); };
  $('kb-root-up').onclick = () => { state.scaleRoot = (state.scaleRoot + 1) % 12; changed(); };
  $('kb-chord').onchange = () => { state.chordOn = $('kb-chord').checked; changed(); };
  // The edit step. Nothing visible depends on it, so it just persists -- no
  // re-derive, and no notify() that would fight the field for focus.
  $('kb-step').oninput = () => {
    const n = +$('kb-step').value;
    if (n >= 0 && n <= 16) { state.editStep = n; savePrefs(); }
  };
  for (const box of $('kb-voicing').querySelectorAll('.kb-tone')) {
    box.onchange = () => { state.chordTones[+box.dataset.tone] = box.checked; changed(); };
  }

  refreshKeyboardPanel();

  // Asks the browser what layout is actually live (Chromium only) and relabels
  // once it answers. Deliberately not awaited before the first paint: the
  // QWERTY fallback is already on screen, and a keyboard that appears a frame
  // later would be worse than one that corrects its own labels.
  detectLayout().then(table => {
    if (!table) return;
    detected = table;
    if (state.kbLayout === 'auto') refreshKeyboardPanel();
  });
}

export function refreshKeyboardPanel() {
  $('kb-octave').textContent = state.octave;

  // The scale's intervals drive both the key tint below and whether the root
  // transpose means anything, so they're read once here rather than per key.
  const intervals = SCALES[state.scaleMode][1];
  $('kb-layout').value = state.kbLayout;
  $('kb-scale').value = state.scaleMode;
  $('kb-root').textContent = PITCH_NAMES[state.scaleRoot];
  $('kb-chord').checked = state.chordOn;
  // Guarded like tracker.js's BPM/rows fields: this one is typed into, and a
  // refresh mid-edit would otherwise stomp a half-entered value.
  if (document.activeElement !== $('kb-step')) $('kb-step').value = state.editStep;
  $('kb-chord-name').textContent = state.chordName;
  for (const box of $('kb-voicing').querySelectorAll('.kb-tone')) {
    box.checked = !!state.chordTones[+box.dataset.tone];
  }
  // Dimmed rather than disabled: a root transpose with no scale, or a
  // voicing with chord mode off, has nothing to act on, but the settings
  // themselves are still worth reading at a glance.
  $('kb-root-group').classList.toggle('off', !intervals);
  $('kb-voicing').classList.toggle('off', !state.chordOn);

  // For each physical key, find which on-screen key it currently plays
  // (state.previewNote's own math: n + state.octave*12) and label that one
  // -- both the bottom-row and QWERTY-row char, where both exist (see
  // BOTTOM_ROW above), each keeping its own slot rather than one
  // overwriting the other.
  const keys = noteKeys();
  const labels = {};
  for (const code in keys) {
    const total = keys[code] + state.octave * 12;
    const oct = Math.floor(total / 12), offset = total - oct * 12;
    if (oct < OCTAVE_MIN || oct > OCTAVE_MAX) continue;
    const key = oct * 12 + offset;
    const slot = BOTTOM_ROW.has(code) ? 0 : 1;
    (labels[key] || (labels[key] = ['', '']))[slot] = codeChar(code);
  }
  for (const [key, el] of keyIndex) {
    const [a, b] = labels[key] || ['', ''];
    const spans = labelSpans.get(el);
    spans[0].textContent = a;
    spans[1].textContent = b;
    // Tint every key of the active scale, whatever octave it's in, so the shape
    // of the scale is visible across the whole piano instead of only where the
    // physical key rows currently reach. keyIndex's key is octave*12 + offset,
    // so % 12 is the pitch class (offset 0 is C, per engine.NOTE_OFFSET).
    el.classList.toggle('kb-in-scale', !!intervals && degreeOfPitch(intervals, state.scaleRoot, key % 12) >= 0);
  }
}
