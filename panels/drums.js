// Drums panel: a step grid over a kit's channels, in the shape of a drum
// machine rather than a tracker.
//
// This is the third view of the same data (state.viewMode 'drums'), alongside
// the tracker grids and the piano roll. It shows one lane per drum voice and
// one column per pattern row of the sequencer's current step, and a click
// toggles a hit. Nothing here is a new data structure: a hit is an ordinary
// note in an ordinary pattern, so anything drawn here can be edited in the
// tracker afterwards and anything typed there shows up here.
//
// Why the view exists at all: the people this is for cannot read a tracker
// column, but they have seen a drum machine. Everything in the panel is
// therefore expressed in bars and beats -- the header numbers the beats, the
// groove library is written in sixteenths (rhythms.js), and the word "channel"
// appears only in small text on the lane heads.
//
// A lane is a channel, because in this song format one channel plays one
// instrument. A four-lane kit therefore spends four of the sixteen channels;
// see rhythms.js's comment on where that limit goes away.
//
// Imports flow one way, exactly as for panels/pianoroll.js: panels/tracker.js
// imports this module in order to draw it in place of the pattern grid, so
// this module must not import tracker.js back. The two things it would want
// from there -- an undo push and an absolute-pitch preview -- are done locally
// and through state.previewAbs respectively.

import * as engine from '../engine.js';
import { state } from '../state.js';
import { KITS, GROOVES, ROLES, resolveKit, rowsOf, barRows } from '../rhythms.js';

const $ = id => document.getElementById(id);

// The kit selected in the header, and the groove selected next to it. UI-only,
// and deliberately not part of state.drumKit: they are what the *next* Set up
// kit / Stamp will use, not a description of what is in the song.
let kitChoice = 0, grooveChoice = 0;

// --- the song side: a lane's pattern at the sequencer's current row ---

// Every channel exists from the start (engine.makeEmptyChannel fills all 16),
// so "free" means nothing has ever been sequenced into it: no pattern number
// anywhere in its sequencer column. That is the only safe definition -- a
// channel with a single entry 40 rows down is part of someone's arrangement.
function isFreeChannel(ch) {
  const p = state.song.songData[ch].p;
  for (let i = 0; i < engine.MAX_SONG_ROWS; i++) if (p[i]) return false;
  return true;
}

function patternNumOf(channel) {
  return state.song.songData[channel].p[state.selRow] || 0;
}

function patternOf(channel) {
  const pn = patternNumOf(channel);
  return pn ? state.song.songData[channel].c[pn - 1] : null;
}

// The lowest pattern number of `channel` with no notes in it. Used when a lane
// needs somewhere to write and the sequencer has nothing at this row yet.
// Returns 0 when all 36 are in use, which the caller reports rather than
// overwriting someone's pattern.
function firstEmptyPattern(channel) {
  const c = state.song.songData[channel].c;
  for (let pn = 1; pn <= engine.MAX_PATTERNS; pn++) {
    if (c[pn - 1].n.every(n => !n)) return pn;
  }
  return 0;
}

// Gives `channel` a pattern at the current sequence row if it hasn't got one,
// so that clicking an empty lane just works instead of refusing the click the
// way the tracker grid has to. Returns the pattern number, or 0 if the channel
// has no free pattern left to give.
function ensurePattern(channel) {
  const pn = patternNumOf(channel);
  if (pn) return pn;
  const fresh = firstEmptyPattern(channel);
  if (!fresh) return 0;
  state.song.songData[channel].p[state.selRow] = fresh;
  engine.recalcSongRanges(state.song);
  return fresh;
}

// Any non-zero note in any of the row's four columns counts as a hit, whatever
// its pitch: a lane's hits are normal notes, so one retuned by hand in the
// tracker must still read as a hit here. Returns the note, or 0.
function hitAt(lane, row) {
  const pattern = patternOf(lane.channel);
  if (!pattern) return 0;
  const len = state.song.patternLen;
  for (let col = 0; col < 4; col++) {
    const n = pattern.n[row + col * len];
    if (n) return n;
  }
  return 0;
}

// A drum row is one hit, so clearing clears all four columns -- a chord in a
// drum lane is not a thing, and leaving a stray note in column 2 would show as
// a step that won't switch off.
function setHit(lane, row, on) {
  const pattern = patternOf(lane.channel);
  if (!pattern) return;
  const len = state.song.patternLen;
  for (let col = 0; col < 4; col++) pattern.n[row + col * len] = 0;
  if (on) pattern.n[row] = lane.note;
}

// --- undo. The stack is shared with the tracker (state.undoStack) and its
// entries name the channel and pattern they belong to, so pushing one per
// channel here works: a stamp that touched four lanes takes four undos to
// unwind, lane by lane, rather than one. Written out locally rather than
// imported because tracker.js imports this module (see the file header). ---
function pushUndoFor(channel) {
  const pn = patternNumOf(channel);
  if (!pn) return;
  const pattern = state.song.songData[channel].c[pn - 1];
  if (!pattern) return;
  state.undoStack.push({
    notes: [...pattern.n], fx: [...pattern.f],
    channel, seqRow: state.selRow, pattern: pn,
  });
  state.redoStack = [];
  if (state.undoStack.length > 50) state.undoStack.shift();
}

// --- the kit: which channel plays which voice ---
//
// state.drumKit is UI state, not song data. It says how to *read* the song,
// and every note it points at is in the song already, so a song exported
// without it loses nothing musical. That is also why it is rediscoverable:
// findKit() below recovers the mapping from the instruments themselves, which
// is what makes a shared link or a library song open straight into this view.

function presetLibrary() {
  return window.gInstrumentPresets || [];
}

// Same instrument, parameter for parameter. Preset data is a flat array of 28
// numbers, so this is the whole of "this channel is playing that preset".
function sameInstrument(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Rebuilds a kit map by looking at what the channels actually play. Only an
// exact preset match counts: a drum sound someone has since edited is no longer
// identifiable as "the kick", and guessing from envelope shape would put a
// plucked bass in the kick lane. Returns null when no kit is recognisable,
// which the panel shows as its empty state rather than as an error.
function findKit() {
  const lib = presetLibrary();
  for (let k = 0; k < KITS.length; k++) {
    const lanes = resolveKit(k, lib);
    if (!lanes) continue;
    const found = [];
    for (const lane of lanes) {
      let channel = -1;
      for (let ch = 0; ch < engine.MAX_CHANNELS; ch++) {
        if (sameInstrument(state.song.songData[ch].i, lane.i)) { channel = ch; break; }
      }
      if (channel < 0) break;
      found.push({ role: lane.role, label: lane.label, note: lane.note, channel });
    }
    if (found.length === lanes.length) return { kit: k, lanes: found };
  }
  return null;
}

// Claims free channels for a kit and puts its sounds in them. Only ever writes
// to channels nothing has been sequenced into, so this cannot damage an
// arrangement in progress -- if there aren't enough, it says so and does
// nothing at all.
function setUpKit(kitIndex) {
  const lanes = resolveKit(kitIndex, presetLibrary());
  if (!lanes) return hint('That kit needs a drum preset that is no longer in your library.');
  const free = [];
  for (let ch = 0; ch < engine.MAX_CHANNELS && free.length < lanes.length; ch++) {
    if (isFreeChannel(ch)) free.push(ch);
  }
  if (free.length < lanes.length) {
    return hint(`A ${lanes.length}-lane kit needs ${lanes.length} unused channels, and this song has ${free.length}.`);
  }
  const mapped = lanes.map((lane, i) => {
    const channel = free[i];
    state.song.songData[channel].i = [...lane.i];
    return { role: lane.role, label: lane.label, note: lane.note, channel };
  });
  state.drumKit = { kit: kitIndex, lanes: mapped };
  // A kit with no patterns is a grid you cannot click into, so each lane gets
  // one at the sequence row you are on.
  for (const lane of mapped) ensurePattern(lane.channel);
  state.selInstrument = mapped[0].channel;
  render();
  notify();
}

// Swaps the sounds of a kit that already exists, keeping its channels and every
// hit written into them: same beat, different drums. This is what the Kit
// select does once a kit is set up -- without it the control would be dead
// after the one time it was read.
//
// Existing hits keep the pitch they were written at rather than being retuned
// to the new lane's note. Every kit here uses the same note per role, so the
// two agree in practice; a hit deliberately retuned by hand is not something a
// change of sound should undo.
function reskinKit(kitIndex) {
  const lanes = resolveKit(kitIndex, presetLibrary());
  if (!lanes) return hint('That kit needs a drum preset that is no longer in your library.');
  for (const lane of state.drumKit.lanes) {
    const next = lanes.find(l => l.role === lane.role);
    if (!next) continue;
    state.song.songData[lane.channel].i = [...next.i];
    lane.note = next.note;
    lane.label = next.label;
  }
  state.drumKit.kit = kitIndex;
  render();
  notify();
}

// --- stamping a groove ---

function anyLaneHasNotes() {
  if (!state.drumKit) return false;
  return state.drumKit.lanes.some(lane => {
    const pattern = patternOf(lane.channel);
    return pattern && pattern.n.some(n => n);
  });
}

// Writes the groove across the whole pattern, repeating its bar until the
// pattern is full, and replaces whatever the kit's lanes held: a groove is the
// starting point of a beat, and merging it into an existing one produces a mess
// nobody asked for. Clear is the same walk with no groove.
function stampGroove(groove) {
  const kit = state.drumKit;
  if (!kit) return;
  const len = state.song.patternLen, beat = Math.max(1, state.beatRows | 0);
  const bar = groove ? barRows(groove, beat) : len;
  for (const lane of kit.lanes) {
    if (!ensurePattern(lane.channel)) {
      hint(`Channel ${lane.channel + 1} has no free pattern left.`);
      continue;
    }
    pushUndoFor(lane.channel);
    const pattern = patternOf(lane.channel);
    for (let i = 0; i < pattern.n.length; i++) pattern.n[i] = 0;
    if (!groove) continue;
    const rows = rowsOf(groove, lane.role, beat);
    for (let start = 0; start < len; start += bar) {
      for (const r of rows) {
        const row = start + r;
        if (row < len) pattern.n[row] = lane.note;
      }
    }
  }
  render();
  notify();
}

// --- rendering ---

let hintTimer = null;
function hint(message) {
  const el = $('drum-hint');
  if (!el) return;
  el.textContent = message;
  el.classList.add('warn');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.classList.remove('warn'); refreshHint(); }, 2600);
}

function refreshHint() {
  const el = $('drum-hint');
  if (!el || el.classList.contains('warn')) return;
  const kit = state.drumKit;
  el.textContent = kit
    ? `${KITS[kit.kit].name} kit on channels ${kit.lanes.map(l => l.channel + 1).join(', ')} · sequence row ${state.selRow}`
    : '';
}

function notify() { state.notify && state.notify(); }

// Beat and bar boundaries are the whole readability of the grid: without them
// sixteen identical cells say nothing about where beat 3 is. Bars come from the
// Beat control the sequencer already has (4 beats to a bar), so the drum grid,
// the tracker's row highlight and the grooves all agree on where a beat is.
const beatRows = () => Math.max(1, state.beatRows | 0);

function stepClasses(row) {
  const beat = beatRows(), cls = [];
  if (row % beat === 0) cls.push('beat');
  if (row % (beat * 4) === 0) cls.push('bar');
  return cls;
}

// Cached per-lane step cells, indexed [lane][row] to match the render below --
// the playback highlight moves a class on one column per row tick and must not
// rebuild the grid to do it (same reasoning as tracker.js's patRowEls).
let cellEls = [];

function renderGrid() {
  const kit = state.drumKit;
  const scroll = $('drum-scroll');
  if (!scroll) return;
  if (!kit) {
    scroll.innerHTML = `
      <div class="drum-empty">
        <p>A kit is four drum sounds on four channels: ${ROLES.map(r => r[1]).join(', ')}.</p>
        <p class="hint">Set up kit takes the first four channels nothing is sequenced into,
        puts the kit's sounds in them, and gives each one a pattern at the sequence row you
        are on. Nothing already in the song is touched.</p>
        <button id="drum-setup" title="Claim four unused channels for this kit">Set up kit</button>
      </div>`;
    $('drum-setup').onclick = () => setUpKit(kitChoice);
    cellEls = [];
    return;
  }
  const len = state.song.patternLen, beat = beatRows();
  let head = '<tr><th class="drum-lane-head"></th>';
  for (let row = 0; row < len; row++) {
    // Number the beats, not the rows: "3" over the third beat is the thing a
    // drummer counts. The rows in between stay blank rather than showing a row
    // number nobody needs here -- the tracker view is where rows are numbered.
    const label = row % beat === 0 ? (row / beat) % 4 + 1 : '';
    head += `<th class="${stepClasses(row).join(' ')}">${label}</th>`;
  }
  head += '</tr>';

  let body = '';
  kit.lanes.forEach((lane, i) => {
    const muted = !state.channelsEnabled[lane.channel];
    const focused = lane.channel === state.selInstrument;
    const pn = patternNumOf(lane.channel);
    body += `<tr class="${focused ? 'focused' : ''}${muted ? ' muted' : ''}" data-lane="${i}">`
      + `<th class="drum-lane-head" data-lane="${i}" title="${lane.label} on channel ${lane.channel + 1}`
      + `${pn ? `, pattern ${pn}` : ', no pattern here yet'}. Click to edit this drum's sound in the instrument panel.">`
      + `<button class="drum-mute" data-lane="${i}" title="${muted ? 'Unmute' : 'Mute'} this lane. Muting leaves it out of Space and Play selected, like muting its channel in the sequencer.">${muted ? '○' : '●'}</button>`
      + `<span class="drum-lane-name">${lane.label}</span>`
      + `<span class="drum-lane-ch">ch ${lane.channel + 1}</span></th>`;
    for (let row = 0; row < len; row++) {
      const cls = stepClasses(row);
      if (hitAt(lane, row)) cls.push('on');
      body += `<td class="${cls.join(' ')}" data-lane="${i}" data-row="${row}"></td>`;
    }
    body += '</tr>';
  });

  scroll.innerHTML = `<table class="drum-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  cellEls = [...scroll.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')]);
}

export function render() {
  if (state.viewMode !== 'drums') return;
  const kitSel = $('drum-kit');
  if (kitSel) kitSel.value = kitChoice;
  const grooveSel = $('drum-groove');
  if (grooveSel) grooveSel.value = grooveChoice;
  renderGrid();
  refreshHint();
  const has = !!state.drumKit;
  for (const id of ['drum-stamp', 'drum-clear']) {
    const b = $(id);
    if (b) b.disabled = !has;
  }
  // A rebuild during playback discards the class the follow highlight lives on,
  // and followPlaybackDrums only repaints on a *change* of row -- so without
  // this the playing column goes dark until the next row tick.
  if (followStep >= 0) paintFollow(followStep, true);
}

export function initDrumsPanel() {
  const panel = $('patterns-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="row drums-header">
      <h3 title="One lane per drum, one column per pattern row of the sequence row you are on. Click a step to switch a hit on or off. The hits are ordinary notes — the tracker view shows the same thing in columns.">Drums</h3>
      <label class="drum-pick" title="Which drum sounds the kit plays. Changing this once a kit is set up swaps the sounds and keeps every hit — the same beat played on a different kit.">Kit
        <select id="drum-kit">${KITS.map((k, i) => `<option value="${i}">${k.name}</option>`).join('')}</select></label>
      <label class="drum-pick" title="A one-bar rhythm to start from. Stamp repeats it across the whole pattern.">Groove
        <select id="drum-groove">${GROOVES.map((g, i) => `<option value="${i}">${g.name}</option>`).join('')}</select></label>
      <button id="drum-stamp" title="Write this groove across the kit's lanes, repeating its bar until the pattern is full. Replaces whatever the lanes hold now.">Stamp</button>
      <button id="drum-clear" title="Empty every lane of this kit at this sequence row.">Clear</button>
      <div class="spacer"></div>
      <span class="hint" id="drum-hint"></span>
    </div>
    <div class="drums-scroll" id="drum-scroll"></div>`;

  $('drum-kit').onchange = () => {
    kitChoice = +$('drum-kit').value;
    $('drum-kit').blur();
    if (state.drumKit) reskinKit(kitChoice);
  };
  $('drum-groove').onchange = () => { grooveChoice = +$('drum-groove').value; $('drum-groove').blur(); };
  $('drum-stamp').onclick = async () => {
    $('drum-stamp').blur();
    if (anyLaneHasNotes() && state.confirm) {
      const ok = await state.confirm('Stamp over this beat?',
        'Stamping replaces every hit in this kit\'s lanes at this sequence row. Undo restores them one lane at a time.',
        'Stamp');
      if (!ok) return;
    }
    stampGroove(GROOVES[grooveChoice]);
  };
  $('drum-clear').onclick = async () => {
    $('drum-clear').blur();
    if (anyLaneHasNotes() && state.confirm) {
      const ok = await state.confirm('Clear this beat?',
        'Every hit in this kit\'s lanes at this sequence row is removed. Undo restores them one lane at a time.',
        'Clear');
      if (!ok) return;
    }
    stampGroove(null);
  };

  const scroll = $('drum-scroll');
  scroll.addEventListener('mousedown', onMouseDown);
  scroll.addEventListener('mouseover', onMouseOver);
  // Bound once on the document, like the other panels' drag handling: a drag
  // that ends outside the grid must still end.
  if (!mouseUpBound) {
    document.addEventListener('mouseup', endPaint);
    mouseUpBound = true;
  }

  render();
}

// --- mouse: click a step to toggle it, drag to paint the same value across
// more steps. Painting a *value* rather than toggling each cell is what a drum
// machine does, and it is the difference between drawing a run of sixteenths in
// one gesture and toggling every other one back off. ---
let mouseUpBound = false;
let paintValue = null;

function laneIndexOf(el) {
  return el.dataset.lane === undefined ? -1 : +el.dataset.lane;
}
function laneOf(el) {
  const lanes = state.drumKit && state.drumKit.lanes;
  return (lanes && lanes[laneIndexOf(el)]) || null;
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  const mute = e.target.closest('.drum-mute');
  if (mute) {
    const lane = laneOf(mute);
    if (lane) {
      state.channelsEnabled[lane.channel] = !state.channelsEnabled[lane.channel];
      render(); notify();
    }
    e.preventDefault();
    return;
  }
  const head = e.target.closest('.drum-lane-head');
  if (head && laneIndexOf(head) >= 0) {
    const lane = laneOf(head);
    if (lane) { focusLane(lane); preview(lane); }
    e.preventDefault();
    return;
  }
  const cell = e.target.closest('td[data-row]');
  if (!cell) return;
  const lane = laneOf(cell), row = +cell.dataset.row;
  if (!lane) return;
  // A lane with no pattern at this sequence row gets one, rather than refusing
  // the click the way the tracker grid has to. That writes a pattern number
  // into the sequencer, so the whole UI has to catch up before anything else
  // happens.
  const had = patternNumOf(lane.channel);
  if (!ensurePattern(lane.channel)) {
    hint(`Channel ${lane.channel + 1} has all 36 patterns in use.`);
    return;
  }
  if (!had) { render(); notify(); }
  pushUndoFor(lane.channel);
  paintValue = !hitAt(lane, row);
  // Before the write: focusing a different lane rebuilds the grid, and
  // applyStep repaints a cell out of the rebuilt one.
  focusLane(lane);
  applyStep(lane, laneIndexOf(cell), row);
  e.preventDefault();
}

function onMouseOver(e) {
  if (paintValue === null) return;
  const cell = e.target.closest('td[data-row]');
  if (!cell) return;
  const lane = laneOf(cell);
  if (!lane || !patternOf(lane.channel)) return;
  const row = +cell.dataset.row;
  if (!!hitAt(lane, row) === paintValue) return;
  applyStep(lane, laneIndexOf(cell), row);
}

// One step: the song write, plus the one class that shows it. Deliberately no
// notify() -- that is a full UI refresh and an autosave, and a paint drag
// crosses a cell per frame. endPaint() does it once when the gesture finishes.
function applyStep(lane, laneIndex, row) {
  setHit(lane, row, paintValue);
  const cell = cellEls[laneIndex] && cellEls[laneIndex][row];
  if (cell) cell.classList.toggle('on', paintValue);
  if (paintValue) preview(lane);
}

function endPaint() {
  if (paintValue === null) return;
  paintValue = null;
  notify();
}

// Focusing a lane points the instrument panel at that drum, which is how its
// sound gets edited -- and it has to happen before any preview, since the
// jammer plays whatever instrument is selected (panels/keyboard.js).
function focusLane(lane) {
  if (state.selInstrument === lane.channel) return;
  state.selInstrument = lane.channel;
  render();
  notify();
}

function preview(lane) {
  state.previewAbs && state.previewAbs(lane.note);
}

// --- playback follow. main.js hands over the row inside the pattern, the same
// number panels/pianoroll.js gets. Only a class moves: the grid is rebuilt just
// when the pattern set changes under it, which for drums means a sequencer step
// (handled by the full render tracker.js already triggers). ---
let followStep = -1;

export function followPlaybackDrums(row) {
  if (state.viewMode !== 'drums' || row === followStep) return;
  paintFollow(followStep, false);
  followStep = row;
  paintFollow(followStep, true);
}

export function stopFollowingDrums() {
  if (followStep < 0) return;
  paintFollow(followStep, false);
  followStep = -1;
}

function paintFollow(row, on) {
  if (row < 0) return;
  for (const lane of cellEls) {
    const cell = lane[row];
    if (cell) cell.classList.toggle('playing', on);
  }
  const head = $('drum-scroll') && $('drum-scroll').querySelector(`thead th:nth-child(${row + 2})`);
  if (head) head.classList.toggle('playing', on);
}

// Re-read the kit from the song. Called after a load, where the map the panel
// is holding describes a song that is no longer open.
export function rediscoverKit() {
  state.drumKit = findKit();
  if (state.drumKit) kitChoice = state.drumKit.kit;
}
