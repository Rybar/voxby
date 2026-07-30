// Note/chord entry pie menu (plans/soundbox-revamp.md Stage E.14). Opened by
// panels/tracker.js when a note cell is double-clicked: a radial overlay with
// the note in an inner ring and the chord quality in an outer one.
//
// This module is deliberately all geometry, labels and gesture -- it knows
// nothing about the song, the pattern grid or how a chord is spelled. Every
// musical answer comes from the `ctx` its caller passes to openPie(), whose
// implementations in tracker.js are the same chordAt()/voiced()/writeChordRow()
// the keyboard paths use. That's what makes it impossible for the pie to
// enter something typing a note wouldn't, and it's also why the import edge
// runs tracker -> pie and never back.
//
// Rings are hit-tested by angle+radius arithmetic rather than by pointer
// events on the <path>s: the wedges are drawn from the same two numbers the
// hit test reads, so the two can't disagree, and the "crossing out of the
// note ring locks the note" behaviour below falls out of a radius comparison
// instead of needing enter/leave bookkeeping per wedge.

import { state } from '../state.js';
import { SCALES, PITCH_NAMES, CHORD_QUALITIES } from '../scales.js';

// Ring boundaries, in px from the center. The hub is a cancel target as well as
// the readout; past R_DEAD a release is also a cancel, so a pie opened by
// accident is dismissed by flicking away from it rather than having to find a
// specific spot. Sized off the labels rather than picked round: the hub has to
// hold a chord name ("Cmaj7") plus the octave without spilling into the note
// ring, and the quality ring has to give 12 wedges an arc that fits "m7♭5".
const R_HUB = 25, R_NOTE = 67, R_QUAL = 118, R_DEAD = 145;

// Scale-degree labels for the inner ring, indexed by semitones above the
// scale root. Deliberately uppercase throughout: this says *which degree*,
// while what quality sits on it is the outer ring's whole job.
const ROMAN = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♭V', 'V', '♭VI', 'VI', '♭VII', 'VII'];

// `null` quality = write the bare note; 'auto' = whatever the scale
// harmonizes it to (tracker.js's diatonic stack, the same one chord mode
// writes on a single keypress).
const SINGLE = { quality: null, name: 'note' };
const AUTO = { quality: 'auto', name: 'auto' };

let open = null;

// The inner ring: the active scale's degrees, or all 12 pitch classes when
// no scale is set. Restricting it under a scale is the point -- it's the same
// promise the remapped Z-M/Q-P key rows make, and it buys much bigger targets
// (a pentatonic gets 5 wedges of 72 degrees each).
function buildRing1() {
  const intervals = SCALES[state.scaleMode][1];
  if (!intervals) return PITCH_NAMES.map((name, pitch) => ({ pitch, name, sub: '' }));
  return intervals.map(iv => ({
    pitch: (iv + state.scaleRoot) % 12,
    name: PITCH_NAMES[(iv + state.scaleRoot) % 12],
    sub: ROMAN[iv],
  }));
}

// The outer ring: the default direction (12 o'clock) first, then the same ten
// qualities the digit row enters, in the same order -- the pie and the
// two-keypress flow teach each other rather than being two vocabularies.
// 'auto' only appears when there's a scale to infer a quality from.
function buildRing2() {
  const scaled = !!SCALES[state.scaleMode][1];
  const digits = Object.keys(CHORD_QUALITIES).map(code => ({ quality: code, name: CHORD_QUALITIES[code][0] }));
  return (scaled ? [AUTO, SINGLE] : [SINGLE]).concat(digits);
}

// --- geometry: angle 0 at 12 o'clock, growing clockwise, so wedge i of n is
// centered on i*(360/n) and the hit test is a plain rounded division. ---
const rad = deg => (deg - 90) * Math.PI / 180;
const px = (r, deg) => R_DEAD + r * Math.cos(rad(deg));
const py = (r, deg) => R_DEAD + r * Math.sin(rad(deg));

function wedgePath(r0, r1, a0, a1) {
  return `M${px(r1, a0)} ${py(r1, a0)}A${r1} ${r1} 0 0 1 ${px(r1, a1)} ${py(r1, a1)}`
    + `L${px(r0, a1)} ${py(r0, a1)}A${r0} ${r0} 0 0 0 ${px(r0, a0)} ${py(r0, a0)}Z`;
}

function pick(list, ang) {
  return Math.round(ang / (360 / list.length)) % list.length;
}

function label(r, ang, text, cls, dy) {
  return `<text class="pie-t ${cls}" x="${px(r, ang)}" y="${py(r, ang)}" dy="${dy}">${text}</text>`;
}

function ring(list, r0, r1, hot, ringCls) {
  const step = 360 / list.length;
  let html = '';
  for (let i = 0; i < list.length; i++) {
    const a = i * step, on = i === hot;
    html += `<path class="pie-w ${ringCls}${on ? ' on' : ''}" d="${wedgePath(r0, r1, a - step / 2, a + step / 2)}"/>`;
  }
  // Text after every wedge so a label is never painted under its neighbour's
  // fill (SVG has no z-index -- document order is the whole stacking rule).
  const mid = (r0 + r1) / 2;
  for (let i = 0; i < list.length; i++) {
    const a = i * step, on = i === hot ? ' on' : '';
    html += list[i].sub
      ? label(mid, a, list[i].name, 'main' + on, -2) + label(mid, a, list[i].sub, 'sub' + on, 9)
      : label(mid, a, list[i].name, 'main' + on, 3);
  }
  return html;
}

function selection() {
  const o = open;
  if (o.noteIdx < 0) return null;
  const note = o.ctx.noteFor(o.ring1[o.noteIdx].pitch);
  const q = o.locked && o.qualIdx >= 0 ? o.ring2[o.qualIdx].quality : null;
  return { note, ...o.ctx.chordFor(note, q) };
}

function draw() {
  const o = open, sel = selection();
  // The 'auto' wedge names the chord it would actually write, once there's a
  // note to harmonize -- the single most useful label on the ring, and the
  // reason ring 2 is redrawn when the note locks rather than built once.
  const ring2 = o.ring2.map(e => e.quality !== 'auto' ? e
    : { ...e, sub: o.noteIdx >= 0 ? o.ctx.chordFor(o.ctx.noteFor(o.ring1[o.noteIdx].pitch), 'auto').name : '' });
  o.svg.innerHTML =
    ring(ring2, R_NOTE, R_QUAL, o.locked ? o.qualIdx : -1, 'pie-r2' + (o.locked ? '' : ' dim'))
    + ring(o.ring1, R_HUB, R_NOTE, o.noteIdx, 'pie-r1')
    + `<circle class="pie-hub" cx="${R_DEAD}" cy="${R_DEAD}" r="${R_HUB}"/>`
    + `<text class="pie-hub-t" x="${R_DEAD}" y="${R_DEAD}" dy="-1">${sel ? sel.name : '·'}</text>`
    + `<text class="pie-hub-t sub" x="${R_DEAD}" y="${R_DEAD}" dy="11">oct ${state.octave}</text>`;
}

// Every hover change funnels through here so the audition and the piano
// shadow are driven by exactly what the ring highlights -- entering a wedge
// *is* the preview trigger, which is the reason to build a pie instead of a
// dropdown.
function setHover(noteIdx, locked, qualIdx) {
  const o = open;
  if (noteIdx === o.noteIdx && locked === o.locked && qualIdx === o.qualIdx) return;
  o.noteIdx = noteIdx; o.locked = locked; o.qualIdx = qualIdx;
  draw();
  const sel = selection();
  o.ctx.preview(sel ? sel.notes : []);
}

function onMove(e) {
  const o = open;
  const dx = e.clientX - o.cx, dy = e.clientY - o.cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  if (r < R_HUB) setHover(-1, false, -1);
  else if (r < R_NOTE) setHover(pick(o.ring1, ang), false, -1);
  // Crossing out of the note ring locks whatever note is under the cursor and
  // hands the outer ring a full circle of its own -- nesting 12 qualities
  // inside one 30-degree note wedge would be unusable. Coming back in
  // unlocks, so a mis-picked note is re-picked without starting over.
  else if (r < R_QUAL) { if (o.noteIdx >= 0) setHover(o.noteIdx, true, pick(o.ring2, ang)); }
  else setHover(o.noteIdx, o.locked, -1);
}

// Releasing over any wedge commits (a note wedge alone = the bare note); the
// hub and the dead zone are cancels. The one exception is the release that
// ends the opening double-click: if the pointer never left the hub, the user
// double-clicked without dragging, so the pie stays up to be clicked at
// instead of vanishing under them.
function onUp() {
  const o = open;
  if (o.noteIdx >= 0) return commit();
  if (o.armed) { o.armed = false; return; }
  closePie();
}

function commit() {
  const sel = selection(), ctx = open.ctx;
  closePie();
  ctx.commit(sel.notes, sel.name, sel.note);
}

// The pie is opened on a row rather than on a key, so it needs some answer to
// "which octave" -- state.octave, overridable live from the wheel or the same
// -/= (and </>) keys that move it everywhere else, is cheaper than spending a
// third ring on it. Re-auditions afterwards: the wedge under the cursor now
// means a different note, and hearing that (and seeing it move on the piano) is
// the point of picking the octave from in here.
function shiftOctave(d) {
  const next = Math.min(8, Math.max(1, state.octave + d));
  if (next === state.octave) return;
  state.octave = next;
  open.ctx.octaveChanged();
  draw();
  const sel = selection();
  open.ctx.preview(sel ? sel.notes : []);
}

function onWheel(e) {
  e.preventDefault();
  shiftOctave(e.deltaY < 0 ? 1 : -1);
}

// Swallows the lot while the pie is up: it's modal, and every key the editor
// binds (Space to play, digits, the note rows) would otherwise fire behind
// it. Capture phase so this runs before the handlers on document -- which is
// also why the octave keys are handled here rather than left to tracker.js's
// own: they have to keep working *and* refresh the pie.
function onKey(e) {
  e.stopPropagation();
  if (e.code === 'Escape') { e.preventDefault(); closePie(); return; }
  if (e.key === '-' || e.key === '<') shiftOctave(-1);
  else if (e.key === '=' || e.key === '>') shiftOctave(1);
}

function closePie() {
  if (!open) return;
  const { el, ctx } = open;
  document.removeEventListener('keydown', onKey, true);
  el.remove();
  open = null;
  ctx.preview([]);
}

// `x`/`y` are viewport coordinates (the opening mousedown's clientX/clientY).
// `ctx` supplies every musical answer: noteFor(pitchClass) -> an absolute note
// number at the current octave, chordFor(note, quality) -> {notes, name},
// preview(notes), commit(notes, name, rootNote), octaveChanged().
export function openPie(x, y, ctx) {
  closePie();
  // Keep the whole outer ring on screen -- the pointer lands wherever the
  // double-clicked cell was, which near an edge would otherwise put half the
  // qualities outside the window.
  const cx = Math.min(Math.max(x, R_QUAL + 4), innerWidth - R_QUAL - 4);
  const cy = Math.min(Math.max(y, R_QUAL + 4), innerHeight - R_QUAL - 4);
  const el = document.createElement('div');
  el.className = 'pie';
  el.innerHTML = `<svg class="pie-svg" width="${R_DEAD * 2}" height="${R_DEAD * 2}"
    style="left:${cx - R_DEAD}px;top:${cy - R_DEAD}px"></svg>`;
  document.body.appendChild(el);
  // `armed` = the button that opened this is still down, so the whole pick can
  // be one drag-and-release. The overlay is full-viewport, which is also what
  // keeps the grid underneath from seeing the mousemoves (tracker.js's
  // drag-select would rubber-band along with the pointer otherwise).
  open = {
    el, svg: el.firstElementChild, ctx, cx, cy,
    ring1: buildRing1(), ring2: buildRing2(),
    noteIdx: -1, locked: false, qualIdx: -1, armed: true,
  };
  el.addEventListener('mousemove', onMove);
  el.addEventListener('mouseup', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  // A right-click is a cancel, not a browser menu: the pie covers the whole
  // viewport, so without this the only thing under the pointer to open a
  // context menu on would be the overlay itself.
  el.addEventListener('contextmenu', e => { e.preventDefault(); closePie(); });
  document.addEventListener('keydown', onKey, true);
  draw();
}
