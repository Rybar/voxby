// SFX view: a workshop for single sounds rather than for music.
//
// This is the fourth view of the tracks row (state.viewMode 'sfx'), alongside
// the tracker grids, the piano roll and the drum grid -- except that the other
// three all draw the song, and this one does not. A sound effect is not part
// of the arrangement, so the sequencer is hidden here (panels/tracker.js's
// render sets the class screen.css keys off) and the whole row is this panel's.
//
// It replaces a modal that had the same recipes in it. The modal could not
// work, for one reason: it covered the instrument panel. Rolling a sound gets
// you an archetype, and the last 20% -- a shorter tail, less resonance, one
// semitone lower -- is knob work, and the knobs were behind the dialog. So
// this view claims the instrument panel instead of hiding it
// (panels/instrument.js's setSfxTarget): every slider down there reads and
// writes the sound being built, and each edit plays it again. The song is
// untouched throughout, and comes back the moment the view is left.
//
// WHAT A SOUND IS HERE
//
// Three things travelling together: the 29 instrument bytes, the step lane,
// and the lane's own timing. Every list in this view -- the variations grid,
// the history, the shelf -- holds that triple plus a rendered thumbnail, and
// `snap()`/`applySound()` are the only two functions that convert between it
// and the live editing state.
//
// Imports flow one way, as for panels/pianoroll.js and panels/drums.js:
// tracker.js imports this module in order to draw it in place of the pattern
// grid, so this module must not import tracker.js back. Live note preview goes
// through state.previewAbs for the same reason (keyboard.js imports tracker.js,
// so importing it here would close a cycle), and the two things only main.js
// can do -- write the preset library, put a file on disk -- go through
// state.sfxSavePreset and state.sfxDownload.
//
// The recipes, the figures and the pack format live in sfx.js; read the
// comment at the top of that file for why a uniform roll of all 29 parameters
// is not worth building.

import * as engine from '../engine.js';
import { state } from '../state.js';
import * as sfx from '../sfx.js';
import { setSfxTarget, clearSfxTarget, sfxTargetChanged } from './instrument.js';
import { keyHandledByFocus } from '../focus.js';
import { renderOneShot, waveformBands } from '../oneshot.js';
import { getAccent } from '../theme.js';

const $ = id => document.getElementById(id);

const escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// The octaves the note picker offers, matching the on-screen keyboard's own
// range in panels/keyboard.js.
const OCT_MIN = 1, OCT_MAX = 8;
const NOTE_LO = OCT_MIN * 12 + engine.NOTE_OFFSET;
const NOTE_HI = (OCT_MAX * 12 + 11) + engine.NOTE_OFFSET;
const DEFAULT_NOTE = 5 * 12 + engine.NOTE_OFFSET;   // C5

// How many sounds a "Roll many" produces. Twelve is about as many as the ear
// will sit through in one pass, and it fills the column without scrolling at a
// normal window height.
const VARIATION_COUNT = 12;

// The history keeps far more than the twelve the old strip did, because the
// one you want back is rarely the one you just left. Liked entries are never
// trimmed -- see pushHistory.
const HISTORY_MAX = 80;

// How often an edit is allowed to retrigger the sound. A slider drag fires
// oninput on every pixel, and a sound effect is a whole gesture rather than a
// held tone -- restarting it 60 times a second is not an audition, it is a
// buzz. Long enough to hear most of a short sound, short enough that the knob
// still feels connected to the speaker. The trailing call is what guarantees
// the value you stopped on is the one you last heard.
const RETRIGGER_MS = 140;

// --- the session ---
// Module-level, not per-render: a roll, a lock and a hand-tuned envelope have
// to survive the panel rebuilding itself, and switching to the tracker to check
// something and back must not lose an hour's work.

let recipeIdx = 0;
let locked = new Set();
let mutateAmt = 0.15;
// The sound being built. Held as one array for the life of the session and
// only ever written *into*, never replaced: panels/instrument.js has the same
// array by reference, so handing it a different one would leave the two sides
// editing different sounds. setWorking() below is the only writer.
let working = null;
let steps = null;              // note number per row, 0 for an empty row
let stepMs = sfx.DEFAULT_STEP_MS;
let selStep = 0;
let sfxName = '';
let variations = [];
let rollHistory = [];
let shelf = [];
// Which history entry the working sound came from, so the list marks where you
// are after a step back rather than always marking the newest roll.
let histSel = -1;
let sideTab = 'history';       // 'history' | 'shelf'
let retrigger = true;
let active = false;

// --- notes ---

function noteName(n) {
  const raw = n - engine.NOTE_OFFSET;
  const oct = Math.floor(raw / 12);
  return NOTE_NAMES[raw - oct * 12] + oct;
}

const noteInRange = n => n >= NOTE_LO && n <= NOTE_HI;

// The pitch a newly filled step takes: the one before it, so laying a figure
// out left to right starts from where you already are rather than from C5
// every time.
function pitchForNewStep(row) {
  for (let r = row - 1; r >= 0; r--) if (steps[r]) return steps[r];
  for (let r = row + 1; r < steps.length; r++) if (steps[r]) return steps[r];
  return DEFAULT_NOTE;
}

// --- a sound, as the lists hold it ---

const snap = () => ({ i: working.slice(), steps: steps.slice(), stepMs });

// Copies into the live arrays rather than swapping them out -- see the comment
// on `working` above for why that array in particular can never be replaced.
function applySound(s) {
  for (let j = 0; j < working.length; j++) working[j] = s.i[j];
  steps = s.steps.slice();
  stepMs = s.stepMs;
  selStep = 0;
}

// --- thumbnails ---
//
// Each list entry carries a rendered picture of itself, because a list of
// twelve sounds that all read "sound" is not a list you can choose from. The
// bands are computed once, when the entry is created, and redrawn from there:
// re-rendering sixty history entries on every repaint would cost more than
// everything else in this view put together.

const THUMB_W = 84, THUMB_H = 20;
// Matches screen.css's --bg0. A canvas draws its own pixels and cannot read a
// CSS variable -- panels/scope.js copies it for the same reason.
const WAVE_BG = '#0d0e11';

function analyse(sound) {
  const r = renderOneShot(sfx.buildSfxSong(sound.i, sound.steps, sfx.msToRowLen(sound.stepMs)));
  return { ...sound, bands: waveformBands(r.samples, THUMB_W), peak: r.peak, clipped: r.clipped, seconds: r.seconds };
}

function drawBands(canvas, bands, w, h) {
  const ctx = canvas.getContext('2d');
  const mid = h / 2;
  ctx.fillStyle = WAVE_BG;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = getAccent();
  const cols = bands.length / 2;
  for (let x = 0; x < w; x++) {
    const c = Math.floor(x * cols / w);
    const lo = bands[c * 2], hi = bands[c * 2 + 1];
    const top = mid - hi * mid, bot = mid - lo * mid;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
  }
}

// Every thumbnail canvas a list just wrote into the DOM, filled from the bands
// stashed on its entry. One pass after innerHTML rather than a canvas ref per
// row: the lists are rebuilt wholesale, so the elements never outlive a
// repaint anyway.
function paintThumbs(containerId, entries) {
  const el = $(containerId);
  if (!el) return;
  for (const c of el.querySelectorAll('canvas[data-n]')) {
    const entry = entries[+c.dataset.n];
    if (!entry || !entry.bands) continue;
    c.width = THUMB_W;
    c.height = THUMB_H;
    drawBands(c, entry.bands, THUMB_W, THUMB_H);
  }
}

// --- audition ---
//
// Played through the jammer, one scheduled note per step, rather than rendered
// through CPlayer: the jammer runs the same FX chain (filter, distortion,
// drive, pan and delay -- see jammer.js's onaudioprocess), so what this plays
// is what the exported file contains, and it starts making a noise on the same
// tick instead of after a render.

let stepTimers = [];
let lastPlayed = 0;
let pendingPlay = null;

function stopAudition() {
  for (const t of stepTimers) clearTimeout(t);
  stepTimers = [];
  clearTimeout(pendingPlay);
  pendingPlay = null;
}

export function playSfx() {
  stopAudition();
  lastPlayed = performance.now();
  if (!state.previewAbs) return;
  for (let r = 0; r < steps.length; r++) {
    if (!steps[r]) continue;
    const note = steps[r];
    if (r === 0) state.previewAbs(note);
    else stepTimers.push(setTimeout(() => state.previewAbs(note), r * stepMs));
  }
}

// Rate-limited playSfx for the edit path. See RETRIGGER_MS above.
function playThrottled() {
  if (!retrigger) return;
  const wait = RETRIGGER_MS - (performance.now() - lastPlayed);
  if (wait <= 0) { playSfx(); return; }
  if (pendingPlay) return;
  pendingPlay = setTimeout(() => { pendingPlay = null; playSfx(); }, wait);
}

// --- the working sound ---

// Files a sound in the history. Liked entries survive the cap: the whole point
// of a like is that it is the one you want to find in an hour, which is
// exactly when eighty unremarkable rolls would otherwise have pushed it off
// the end.
function pushHistory(sound) {
  rollHistory.unshift(analyse(sound));
  if (rollHistory.length > HISTORY_MAX) {
    let n = rollHistory.length - 1;
    while (n > 0 && rollHistory[n].liked) n--;
    rollHistory.splice(n, 1);
  }
  histSel = 0;
}

function setSound(sound, { remember = true, play = true, from = -1 } = {}) {
  applySound(sound);
  if (remember) pushHistory(snap());
  else histSel = from;
  // Before render(), and before playSfx() below: the jammer plays a snapshot,
  // so it has to be handed the new sound or the audition is of the old one.
  sfxTargetChanged();
  render();
  if (play) playSfx();
}

// Which lock group holds a property, for the auto-pin below.
function groupOf(prop) {
  for (const [label, props] of sfx.GROUPS) if (props.includes(prop)) return label;
  return null;
}

// Every write from the instrument panel lands here.
//
// The auto-pin is the whole reason rolling and hand-tuning are one workflow
// rather than two. Roll a zap, shorten its release by hand, roll again -- and
// without this, the roll throws the release away, because the roll has no way
// to know that one of the 29 values was chosen rather than rolled. Touching a
// control is that signal. A paste or a preset load (prop -1) replaces
// everything and so says nothing about any one group; it pins nothing.
function onInstrWrite(prop) {
  const group = prop >= 0 && groupOf(prop);
  if (group && !locked.has(group)) {
    locked.add(group);
    renderLocks();
  }
  // A hand edit leaves the history entry it started from, so nothing is
  // highlighted any more: what is on screen is no longer any of them.
  histSel = -1;
  playThrottled();
  scheduleWave();
}

// Read hook for tests/soundbox/test-sfx.mjs, hung on window.soundbox by
// main.js. Everything this view holds is module-local by design (see "the
// session" above), and a test cannot otherwise tell a sound that was edited
// from one that was not. Getters rather than a snapshot, so a suite reads the
// live values after driving real input at real controls.
export const sfxHook = {
  get working() { return working && working.slice(); },
  get steps() { return steps && steps.slice(); },
  get locked() { return [...locked].sort(); },
  get recipe() { return sfx.RECIPES[recipeIdx].name; },
  get stepMs() { return stepMs; },
  get selStep() { return selStep; },
  get active() { return active; },
  get variations() { return variations.map(v => ({ notes: v.steps.filter(Boolean).length, stepMs: v.stepMs, peak: v.peak })); },
  get history() { return rollHistory.map(h => ({ liked: !!h.liked, notes: h.steps.filter(Boolean).length })); },
  get shelf() { return shelf.map(s => ({ name: s.name, notes: s.steps.filter(Boolean).length })); },
  packText: () => sfx.packToJS(shelf),
  song: () => sfx.buildSfxSong(working, steps, sfx.msToRowLen(stepMs)),
};

// --- entering and leaving ---

// Called by tracker.js's render() before it draws this view. Seeds the sound
// from the selected channel the first time only: after that the session's own
// sound is what comes back, so a trip to the tracker and back does not throw
// away what was on screen.
export function enterSfxView() {
  if (active) return;
  active = true;
  if (!working) {
    working = state.song.songData[state.selInstrument].i.slice();
    steps = Array(sfx.STEPS).fill(0);
    steps[0] = DEFAULT_NOTE;
    sfxName = sfx.RECIPES[recipeIdx].name;
  }
  setSfxTarget(working, onInstrWrite);
}

// Called by tracker.js's render() for every other view, so it has to be a
// no-op when this one was never open.
export function leaveSfxView() {
  if (!active) return;
  active = false;
  stopAudition();
  clearSfxTarget();
}

// --- rendering ---

function recipeRailHTML() {
  return sfx.RECIPES.map((r, n) => `
    <button type="button" class="sfx-recipe${n === recipeIdx ? ' active' : ''}" data-n="${n}"
      title="${escapeHtml(r.hint)}">
      <b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.hint)}</span>
    </button>`).join('');
}

function noteOptionsHTML(selected) {
  let html = '';
  for (let oct = OCT_MIN; oct <= OCT_MAX; oct++) {
    for (let s = 0; s < 12; s++) {
      const note = oct * 12 + s + engine.NOTE_OFFSET;
      html += `<option value="${note}"${note === selected ? ' selected' : ''}>${NOTE_NAMES[s]}${oct}</option>`;
    }
  }
  return html;
}

function renderLocks() {
  const el = $('sfx-locks');
  if (!el) return;
  el.innerHTML = sfx.GROUPS.map(([label]) => `
    <label class="sfx-lock" title="Keep this group's settings through the next roll.">
      <input type="checkbox" class="sfx-lock-box" data-group="${escapeHtml(label)}"${locked.has(label) ? ' checked' : ''}>
      ${escapeHtml(label)}</label>`).join('');
  for (const box of el.querySelectorAll('.sfx-lock-box')) {
    box.onchange = () => { box.checked ? locked.add(box.dataset.group) : locked.delete(box.dataset.group); };
  }
}

function renderSteps() {
  const el = $('sfx-steps');
  if (!el) return;
  el.innerHTML = steps.map((n, r) => `
    <button type="button" class="sfx-step${n ? ' on' : ''}${r === selStep ? ' sel' : ''}" data-r="${r}"
      title="Step ${r + 1}${n ? ' — ' + noteName(n) : ' — empty'}. Click to select it, click again to clear it. Play a key or scroll here to set its pitch.">
      <span class="sfx-step-n">${r + 1}</span>
      <span class="sfx-step-note">${n ? escapeHtml(noteName(n)) : '·'}</span>
    </button>`).join('');
}

// --- the variations grid ---
//
// Rolling one sound at a time and listening to it is the slowest part of this
// job: most rolls are wrong, and you only know which by hearing them. Twelve
// at once turns that into a spread the eye can narrow before the ear starts --
// a silent one and a clipped one are visible in their thumbnails, and the
// remaining few are worth clicking.
//
// Each is rolled with the current locks, so a grid rolled with Env locked is
// twelve versions of *your* envelope rather than twelve unrelated sounds.
function renderVariations() {
  const el = $('sfx-variations');
  if (!el) return;
  el.innerHTML = variations.length
    ? variations.map((v, n) => {
      const notes = v.steps.filter(Boolean).length;
      return `
        <div class="sfx-var${v.clipped ? ' hot' : ''}" data-n="${n}" data-take="${n}"
          title="${v.seconds.toFixed(2)} s · peak ${v.peak.toFixed(2)} · ${notes} note${notes === 1 ? '' : 's'}. Click to take it — it becomes the sound you are editing, and goes in the history.">
          <canvas data-n="${n}" data-take="${n}"></canvas>
          <div class="sfx-var-foot">
            <span class="sfx-var-n mono" data-take="${n}">${n + 1}</span>
            <span class="mono" data-take="${n}">${v.seconds.toFixed(2)}s</span>
            <span class="mono sfx-var-notes" data-take="${n}">${notes}♪</span>
            <div class="spacer" data-take="${n}"></div>
            <button type="button" class="sfx-var-shelve" data-shelve="${n}"
              title="Put this one straight on the shelf, without taking it into the editor first — the way to keep six good ones out of a batch of twelve.">+</button>
          </div>
        </div>`;
    }).join('')
    : '<span class="hint">Roll a batch and pick from the pictures — a silent one and a clipped one are visible before you hear either.</span>';
  paintThumbs('sfx-variations', variations);
}

function renderHistory() {
  const el = $('sfx-list');
  if (!el || sideTab !== 'history') return;
  el.innerHTML = rollHistory.length
    ? rollHistory.map((h, n) => `
        <div class="sfx-row${n === histSel ? ' active' : ''}${h.liked ? ' liked' : ''}" data-n="${n}">
          <button type="button" class="sfx-like" data-like="${n}"
            title="${h.liked ? 'Liked — kept even when older entries are dropped. Click to unlike.' : 'Like this one, to find it again later. Liked entries are never trimmed.'}">${h.liked ? '★' : '☆'}</button>
          <canvas data-n="${n}" title="Go back to this sound"></canvas>
          <span class="sfx-row-meta mono" title="Go back to this sound">${h.seconds.toFixed(2)}s</span>
        </div>`).join('')
    : '<span class="hint">Every roll and mutation lands here. Star the ones worth coming back to.</span>';
  paintThumbs('sfx-list', rollHistory);
}

function renderShelf() {
  const el = $('sfx-list');
  if (!el || sideTab !== 'shelf') return;
  el.innerHTML = shelf.length
    ? shelf.map((s, n) => `
        <div class="sfx-row" data-shelf="${n}">
          <canvas data-n="${n}" title="Load this sound back into the editor"></canvas>
          <input class="sfx-shelf-name" data-name="${n}" value="${escapeHtml(s.name)}" maxlength="24"
            title="What this sound is called in the exported pack. It becomes the index constant, upper-cased.">
          <button type="button" class="sfx-shelf-del" data-del="${n}" title="Take this one off the shelf">×</button>
        </div>`).join('')
    : '<span class="hint">Add finished sounds here, then export the lot as one .js pack — a game wants jump, hurt and coin together, not three downloads.</span>';
  paintThumbs('sfx-list', shelf);
}

function renderSide() {
  for (const b of $('sfx-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tab === sideTab);
  }
  $('sfx-shelf-count').textContent = shelf.length ? ` (${shelf.length})` : '';
  $('sfx-export-pack').style.display = sideTab === 'shelf' ? '' : 'none';
  if (sideTab === 'history') renderHistory(); else renderShelf();
}

// --- the picture of the sound ---
//
// Rendered exactly as it will export -- the same song sfx.buildSfxSong hands
// the file writer, through the same synth the worker runs (../oneshot.js).
// So the trace is not an impression of the sound, it is the sound, and the
// peak beside it is measured rather than guessed at. Three of the four things
// that make a sound effect unusable are visible here and nowhere else: it is
// silent, it is clipping, or it is four seconds long when you thought it was
// half of one.
//
// Coalesced into one draw per frame. A slider drag fires oninput on every
// pixel of travel, and a render is milliseconds rather than microseconds --
// once per frame is both the most the eye can use and the least work that
// still looks live.
let waveDirty = false, lastRender = null;

function scheduleWave() {
  if (waveDirty) return;
  waveDirty = true;
  requestAnimationFrame(() => {
    waveDirty = false;
    drawWave();
    renderReadout();
  });
}

function drawWave() {
  const c = $('sfx-wave');
  if (!c || !working) return;
  if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
    c.width = c.clientWidth;
    c.height = c.clientHeight;
  }
  const w = c.width, h = c.height, mid = h / 2;
  if (!w || !h) return;
  const ctx = c.getContext('2d');

  lastRender = renderOneShot(sfx.buildSfxSong(working, steps, sfx.msToRowLen(stepMs)));
  drawBands(c, waveformBands(lastRender.samples, w), w, h);

  // The full-scale lines, drawn over the trace: without them a quiet sound and
  // a clipping one look identical, since the trace is scaled to the canvas
  // either way.
  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.beginPath();
  ctx.moveTo(0, mid); ctx.lineTo(w, mid);
  ctx.moveTo(0, 0.5); ctx.lineTo(w, 0.5);
  ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  // Where each step lands, so a figure that reads as one gesture by ear can be
  // checked against the steps that made it.
  const rowLen = sfx.msToRowLen(stepMs);
  const totalFrames = lastRender.samples.length / 2;
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  for (let r = 0; r < steps.length; r++) {
    if (!steps[r] || !totalFrames) continue;
    const x = Math.round(r * rowLen / totalFrames * w);
    if (x < w) ctx.fillRect(x, 0, 1, h);
  }
}

// The numbers under the trace. Length and rows are arithmetic (sfx.js); the
// peak comes from the render above, so "silent" and "clipping" are measured
// facts rather than a guess from the parameter values -- there are too many
// ways for 29 parameters to add up to nothing for a guess to be worth making.
function renderReadout() {
  const el = $('sfx-readout');
  if (!el) return;
  const rowLen = sfx.msToRowLen(stepMs);
  const rows = sfx.songRowsFor(working, steps, rowLen);
  const seconds = rows * rowLen / sfx.SAMPLE_RATE;
  const notes = steps.filter(Boolean).length;
  const peak = lastRender ? lastRender.peak : 0;
  let warn = '';
  if (!notes) warn = 'No steps — this sound is silent.';
  else if (lastRender && peak < 0.005) warn = 'Nothing audible: check Drive, the oscillator volumes and the filter.';
  else if (lastRender && lastRender.clipped) warn = 'Clipping. Bring Drive or the oscillator volumes down.';
  else if (rows >= sfx.MAX_PATTERN_ROWS) warn = `Tail runs past ${sfx.MAX_PATTERN_ROWS} rows — the export is cut short. Shorten the release or the delay.`;
  el.innerHTML = `<span class="mono">${seconds.toFixed(2)} s · ${rows} rows · ${notes} note${notes === 1 ? '' : 's'}`
    + (lastRender ? ` · peak ${peak.toFixed(2)}` : '') + `</span>`
    + (warn ? `<span class="sfx-warn">${escapeHtml(warn)}</span>` : '');
}

export function render() {
  if (state.viewMode !== 'sfx' || !$('sfx-body')) return;
  for (const b of $('sfx-recipes').querySelectorAll('.sfx-recipe')) {
    const on = +b.dataset.n === recipeIdx;
    b.classList.toggle('active', on);
    // The rail is taller than its column and only a few recipes show at once,
    // so the selected one has to be brought to where it can be seen -- a
    // keyboard shortcut or a restored session can select one that is scrolled
    // well out of sight. 'nearest' so a recipe already on screen doesn't jump.
    if (on) b.scrollIntoView({ block: 'nearest' });
  }
  renderLocks();
  renderSteps();
  renderVariations();
  renderSide();
  scheduleWave();
  $('sfx-step-note').value = steps[selStep] || pitchForNewStep(selStep);
  $('sfx-step-ms').value = stepMs;
  $('sfx-step-ms-val').textContent = stepMs + ' ms';
  $('sfx-mutate-amt').value = Math.round(mutateAmt * 100);
  $('sfx-mutate-amt-val').textContent = Math.round(mutateAmt * 100) + '%';
  $('sfx-name').value = sfxName;
  $('sfx-retrigger').checked = retrigger;
  $('sfx-use').textContent = `Use on ch ${state.selInstrument + 1}`;
}

let sayTimer = null;
function say(message) {
  const el = $('sfx-status');
  if (!el) return;
  el.textContent = message;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { if ($('sfx-status')) $('sfx-status').textContent = ''; }, 4000);
}

// --- actions ---

function roll() {
  setSound({ i: sfx.rollInstrument(sfx.RECIPES[recipeIdx], working, locked), steps, stepMs });
}

function mutate() {
  setSound({ i: sfx.mutateInstrument(sfx.RECIPES[recipeIdx], working, locked, mutateAmt), steps, stepMs });
}

// A batch, each with its own figure: the figure is as much of what makes a
// sound wrong as the parameters are, so a grid that varied only the 29 bytes
// would be twelve versions of one rhythm.
function rollVariations() {
  const recipe = sfx.RECIPES[recipeIdx];
  const root = steps[0] || DEFAULT_NOTE;
  variations = [];
  for (let n = 0; n < VARIATION_COUNT; n++) {
    const f = sfx.rollFigure(recipe, root, { lo: NOTE_LO, hi: NOTE_HI });
    variations.push(analyse({
      i: sfx.rollInstrument(recipe, working, locked),
      steps: f.steps,
      stepMs: f.stepMs,
    }));
  }
  renderVariations();
}

function setStep(row, note) {
  steps[row] = note;
  histSel = -1;
  renderSteps();
  scheduleWave();
  playThrottled();
}

// Writes a played note into the selected step and moves on, so a figure can be
// played in rather than clicked in. Wraps at the end rather than stopping: a
// lane of 16 is longer than any sound effect wants, and running off the end
// silently would look like the key did nothing.
export function enterStepNote(note) {
  if (!active) return;
  steps[selStep] = note;
  selStep = (selStep + 1) % steps.length;
  histSel = -1;
  const noteSel = $('sfx-step-note');
  if (noteSel) noteSel.value = note;
  renderSteps();
  scheduleWave();
}

// A rolled figure for the current recipe. Rooted at whatever the selected step
// already holds, so filling repeatedly explores shapes and timings around the
// pitch you settled on instead of jumping somewhere new each press -- the same
// reason a roll keeps a locked group.
//
// This rolls the *lane*, not the sound. The two are separate presses because
// they are separate decisions: a zap you like at one note is still that zap
// when it becomes three, and re-rolling the sound every time you tried a
// figure would mean never hearing the same sound twice.
function fillSteps() {
  const f = sfx.rollFigure(sfx.RECIPES[recipeIdx], steps[selStep] || pitchForNewStep(0),
    { lo: NOTE_LO, hi: NOTE_HI });
  steps = f.steps;
  stepMs = f.stepMs;
  selStep = 0;
  histSel = -1;
  render();
  playSfx();
  say(`${f.shape} · ${f.rhythm} · ${f.stepMs} ms`);
}

function transposeSteps(by) {
  const next = steps.map(n => (n ? n + by : 0));
  if (next.some(n => n && !noteInRange(n))) return;
  steps = next;
  histSel = -1;
  renderSteps();
  scheduleWave();
  playSfx();
}

// Shelves a sound, naming it from the Name field. `sound` may already carry
// its bands (a variation card does), so it is only re-rendered when it has to
// be. A number is appended when the name is already taken: the pack's index
// constants have to be unique, and finding that out at export time -- after
// six sounds have gone on under the same name -- is too late to be useful.
function shelfPush(sound) {
  let name = sfxName.trim().slice(0, 24) || sfx.RECIPES[recipeIdx].name;
  if (shelf.some(s => s.name === name)) {
    let n = 2;
    while (shelf.some(s => s.name === `${name} ${n}`)) n++;
    name = `${name} ${n}`;
  }
  shelf.push(sound.bands ? { ...sound, name } : analyse({ ...sound, name }));
  sideTab = 'shelf';
  renderSide();
  say(`"${name}" on the shelf — ${shelf.length} sound${shelf.length === 1 ? '' : 's'} ready to export as a pack.`);
}

// --- keyboard ---
//
// Installed once and guarded on the view, the same shape as
// panels/pianoroll.js's handler. tracker.js's own onKeyDown returns early for
// every view but its own, so nothing here is ever claimed twice.

function onSfxKeyDown(e) {
  if (state.viewMode !== 'sfx') return;
  if (keyHandledByFocus(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  // Notes first: they are the reason this view has a keyboard at all, and they
  // must not be shadowed by a shortcut. state.previewNote plays the note and
  // hands back the number, exactly as it does for the tracker's note entry.
  const n = state.noteKeys ? state.noteKeys()[e.code] : undefined;
  if (n !== undefined) {
    const note = state.previewNote ? state.previewNote(n) : n + state.octave * 12 + engine.NOTE_OFFSET;
    enterStepNote(note);
    e.preventDefault();
    return;
  }

  switch (e.code) {
    case 'KeyR': roll(); break;
    case 'KeyM': mutate(); break;
    case 'KeyF': fillSteps(); break;
    case 'KeyV': rollVariations(); break;
    case 'KeyL': if (rollHistory[histSel]) { toggleLike(histSel); } break;
    case 'Enter': playSfx(); break;
    case 'ArrowLeft': selStep = (selStep + steps.length - 1) % steps.length; renderSteps(); break;
    case 'ArrowRight': selStep = (selStep + 1) % steps.length; renderSteps(); break;
    case 'ArrowUp': case 'ArrowDown': {
      const by = (e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      if (steps[selStep] && noteInRange(steps[selStep] + by)) setStep(selStep, steps[selStep] + by);
      break;
    }
    case 'Delete': case 'Backspace': setStep(selStep, 0); break;
    default: return;
  }
  e.preventDefault();
}

function toggleLike(n) {
  const h = rollHistory[n];
  if (!h) return;
  h.liked = !h.liked;
  renderSide();
}

// --- panel ---

export function initSfxPanel() {
  const panel = $('patterns-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="row sfx-header">
      <h3 title="Build one-shot sound effects. Nothing here touches the song — the sliders in the instrument panel below edit this sound instead, and the channel comes back the moment you leave this view.">Sound effects</h3>
      <button id="sfx-play" type="button" title="Play the sound again (Enter)">Play</button>
      <label class="sfx-toggle" title="Play the sound again every time you move a control in the instrument panel. Turn it off to make a series of changes in silence.">
        <input id="sfx-retrigger" type="checkbox"> play on edit</label>
      <span class="hint">Keys write steps · R roll · V rolls twelve · F fill · M mutate · L like · Enter play</span>
      <div class="spacer"></div>
      <span class="hint" id="sfx-status"></span>
    </div>
    <div class="sfx-body" id="sfx-body">

      <div class="sfx-col sfx-col-recipes">
        <h4 title="What kind of sound to roll. Each recipe fixes the parameters that decide whether it is that sound at all, and varies the rest.">Kind</h4>
        <div class="sfx-rail" id="sfx-recipes">${recipeRailHTML()}</div>
      </div>

      <div class="sfx-col sfx-col-lane">
        <div class="sfx-roll-row">
          <button id="sfx-roll" type="button" title="Roll every unlocked group again from scratch (R)">Roll</button>
          <button id="sfx-mutate" type="button" title="Nudge the sound instead of replacing it — the same sound, slightly different (M)">Mutate</button>
          <label class="sfx-slider sfx-slider-narrow" title="How far a mutation moves each value, as a share of the recipe's own range for it.">Nudge
            <input id="sfx-mutate-amt" type="range" min="2" max="50" step="1">
            <span class="mono" id="sfx-mutate-amt-val"></span></label>
          <span class="sfx-keep-label" title="A locked group keeps what it has through the next roll. Any control you move by hand locks its own group, so rolling again keeps your work.">Keep</span>
          <div class="sfx-locks" id="sfx-locks"></div>
        </div>
        <div class="sfx-steps" id="sfx-steps"
          title="The notes the effect plays, one per step. Most sounds are one note; a pickup is two, a fanfare three or four. The synth's arpeggio cannot do this — it repeats one fixed interval at one fixed speed.&#10;&#10;Click an empty step to fill it, click a filled one again to clear it. Play a key to write the selected step and move on. Scroll the wheel over a step, or use the up and down arrows, to change its pitch — hold Shift for octaves."></div>
        <div class="sfx-lane-controls">
          <label title="The pitch of the selected step.">Note
            <select id="sfx-step-note">${noteOptionsHTML(DEFAULT_NOTE)}</select></label>
          <button id="sfx-oct-down" type="button" title="Move every step down an octave">8vb</button>
          <button id="sfx-oct-up" type="button" title="Move every step up an octave">8va</button>
          <button id="sfx-fill" type="button" title="Roll a figure for this recipe (F): how many notes, what shape they make, which intervals they use, what rhythm they land on, and how fast they run. A pickup climbs, an alarm alternates, a warp falls away in widening drops.">Fill</button>
          <button id="sfx-clear-steps" type="button" title="Clear every step but the first">Clear</button>
          <label class="sfx-slider sfx-slider-wide" title="The gap between steps. A sound effect keeps its own timing — it does not follow the song's tempo, because the game it ships in has no tempo.">Step
            <input id="sfx-step-ms" type="range" min="${sfx.MIN_STEP_MS}" max="${sfx.MAX_STEP_MS}" step="1">
            <span class="mono" id="sfx-step-ms-val"></span></label>
        </div>
        <div class="sfx-readout" id="sfx-readout"></div>
        <canvas id="sfx-wave" title="The sound as it will export, rendered through the same synth. The faint lines are full scale: a trace that touches them is clipping. The vertical marks are where each step falls."></canvas>
      </div>

      <div class="sfx-col sfx-col-vars">
        <div class="sfx-col-head">
          <h4 title="Twelve rolls at once, each with its own figure. Pick from the pictures: a silent one and a clipped one are visible before you hear either.">Variations</h4>
          <div class="spacer"></div>
          <button id="sfx-roll-many" type="button" title="Roll ${VARIATION_COUNT} sounds at once, respecting the same locks (V)">Roll ${VARIATION_COUNT}</button>
        </div>
        <div class="sfx-vars" id="sfx-variations"></div>
      </div>

      <div class="sfx-col sfx-col-out">
        <label class="sfx-field" title="Names the preset, the exported file, and this sound's entry in a pack.">Name
          <input id="sfx-name" type="text" maxlength="40"></label>
        <div class="sfx-actions">
          <button id="sfx-shelve" type="button" title="Put this sound on the shelf, to be exported later along with the others as one pack">+ Shelf</button>
          <button id="sfx-export" type="button" title="Download this one sound as a one-channel song — the same shape as src/js/sounds/tada.js">Export .js</button>
          <button id="sfx-save" type="button" title="Save this sound's instrument into the preset library, under an SFX category">Preset</button>
          <button id="sfx-use" type="button" title="Copy this sound onto the channel the instrument panel names, replacing its instrument. The sound effect stays here as well.">Use on ch</button>
        </div>
        <div class="sfx-tabs" id="sfx-tabs">
          <button type="button" data-tab="history" title="Every roll and mutation of this session, newest first. Star one to keep it.">History</button>
          <button type="button" data-tab="shelf" title="The sounds you have set aside, and the pack export that writes them all to one file.">Shelf<span id="sfx-shelf-count"></span></button>
        </div>
        <div class="sfx-list" id="sfx-list"></div>
        <button id="sfx-export-pack" type="button" title="Download every shelved sound as one .js pack, with an index constant per name. Load it with core/sfxpack.js's expandPack.">Export pack .js</button>
      </div>

    </div>`;

  $('sfx-play').onclick = () => { $('sfx-play').blur(); playSfx(); };
  $('sfx-retrigger').onchange = () => { retrigger = $('sfx-retrigger').checked; };

  $('sfx-recipes').onclick = e => {
    const btn = e.target.closest('.sfx-recipe');
    if (!btn) return;
    recipeIdx = +btn.dataset.n;
    // The name follows the recipe only while it is still the recipe's own -- a
    // name someone typed is theirs, and switching kind must not eat it.
    if (sfx.RECIPES.some(r => r.name === sfxName)) sfxName = sfx.RECIPES[recipeIdx].name;
    render();
  };

  $('sfx-roll').onclick = () => { $('sfx-roll').blur(); roll(); };
  $('sfx-mutate').onclick = () => { $('sfx-mutate').blur(); mutate(); };
  $('sfx-roll-many').onclick = () => { $('sfx-roll-many').blur(); rollVariations(); };
  $('sfx-mutate-amt').oninput = () => {
    mutateAmt = +$('sfx-mutate-amt').value / 100;
    $('sfx-mutate-amt-val').textContent = $('sfx-mutate-amt').value + '%';
  };

  // Two things a card can do. Shelving straight from the grid is the one that
  // matters: a batch of twelve usually holds two or three worth keeping, and
  // making you take each into the editor first to save it would mean losing
  // the rest of the batch's place in your ear.
  $('sfx-variations').onclick = e => {
    const shelve = e.target.closest('[data-shelve]');
    if (shelve) {
      shelfPush(variations[+shelve.dataset.shelve]);
      return;
    }
    const take = e.target.closest('[data-take]');
    if (take) setSound(variations[+take.dataset.take]);
  };

  // A click selects a step; a click on the step already selected clears it,
  // which is how one control does both without a modifier to remember.
  $('sfx-steps').onclick = e => {
    const btn = e.target.closest('.sfx-step');
    if (!btn) return;
    const r = +btn.dataset.r;
    if (r === selStep && steps[r]) { setStep(r, 0); return; }
    selStep = r;
    if (!steps[r]) setStep(r, pitchForNewStep(r));
    else { renderSteps(); playSfx(); }
    $('sfx-step-note').value = steps[r] || pitchForNewStep(r);
  };

  // The wheel over a step is the fastest way to find a pitch by ear: it plays
  // the whole figure at each new value, so a two-note pickup is tuned by
  // listening to the interval rather than to the note alone.
  $('sfx-steps').onwheel = e => {
    const btn = e.target.closest('.sfx-step');
    if (!btn) return;
    const r = +btn.dataset.r;
    if (!steps[r]) return;
    const by = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 12 : 1);
    if (!noteInRange(steps[r] + by)) return;
    selStep = r;
    setStep(r, steps[r] + by);
    $('sfx-step-note').value = steps[r];
    e.preventDefault();
  };

  $('sfx-step-note').onchange = () => {
    setStep(selStep, +$('sfx-step-note').value);
    $('sfx-step-note').blur();
  };
  $('sfx-fill').onclick = () => { $('sfx-fill').blur(); fillSteps(); };
  $('sfx-oct-down').onclick = () => { $('sfx-oct-down').blur(); transposeSteps(-12); };
  $('sfx-oct-up').onclick = () => { $('sfx-oct-up').blur(); transposeSteps(12); };
  $('sfx-clear-steps').onclick = () => {
    $('sfx-clear-steps').blur();
    // The first step survives: a sound with no notes at all is silence, and
    // there is no reason to make someone put one back before they can listen.
    for (let r = 1; r < steps.length; r++) steps[r] = 0;
    if (!steps[0]) steps[0] = DEFAULT_NOTE;
    selStep = 0;
    renderSteps();
    scheduleWave();
    playSfx();
  };

  $('sfx-step-ms').oninput = () => {
    stepMs = +$('sfx-step-ms').value;
    $('sfx-step-ms-val').textContent = stepMs + ' ms';
    scheduleWave();
    playThrottled();
  };

  $('sfx-name').oninput = () => { sfxName = $('sfx-name').value; };

  $('sfx-shelve').onclick = () => { $('sfx-shelve').blur(); shelfPush(snap()); };

  $('sfx-save').onclick = () => {
    const name = sfxName.trim().slice(0, 40) || sfx.RECIPES[recipeIdx].name;
    if (!state.sfxSavePreset) return;
    state.sfxSavePreset(name, working.slice());
    // A preset is one instrument, and this sound may be several notes -- say
    // so rather than let the step lane appear to have been saved with it.
    const notes = steps.filter(Boolean).length;
    say(`Saved "${name}" to presets.` + (notes > 1 ? ' The steps are not part of a preset — export for those.' : ''));
  };

  const fileName = name =>
    (String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sfx') + '.js';

  $('sfx-export').onclick = () => {
    const name = sfxName.trim() || sfx.RECIPES[recipeIdx].name;
    if (!state.sfxDownload) return;
    const song = sfx.buildSfxSong(working, steps, sfx.msToRowLen(stepMs));
    state.sfxDownload(new Blob([engine.songToJS(song)], { type: 'text/plain' }), fileName(name));
    say(`Exported ${fileName(name)} — ${steps.filter(Boolean).length} note(s) over ${song.patternLen} rows.`);
  };

  $('sfx-export-pack').onclick = () => {
    if (!state.sfxDownload) return;
    if (!shelf.length) { say('Nothing on the shelf yet — build a sound and press + Shelf.'); return; }
    const name = fileName(sfxName.trim() || 'sounds');
    state.sfxDownload(new Blob([sfx.packToJS(shelf)], { type: 'text/plain' }), name);
    say(`Exported ${name} — ${shelf.length} sounds. Load it with core/sfxpack.js's expandPack.`);
  };

  $('sfx-use').onclick = () => {
    const dest = state.song.songData[state.selInstrument].i;
    for (let j = 0; j < dest.length; j++) dest[j] = working[j];
    say(`Channel ${state.selInstrument + 1} now plays this sound.`);
    if (state.notify) state.notify();
  };

  $('sfx-tabs').onclick = e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    sideTab = btn.dataset.tab;
    renderSide();
  };

  // One delegated handler for both lists, because only one of them is in the
  // DOM at a time -- the tab decides which, and the data attributes say which
  // kind of row was hit.
  $('sfx-list').onclick = e => {
    const like = e.target.closest('[data-like]');
    if (like) { toggleLike(+like.dataset.like); return; }
    const del = e.target.closest('[data-del]');
    if (del) { shelf.splice(+del.dataset.del, 1); renderSide(); return; }
    const shelfRow = e.target.closest('[data-shelf]');
    if (shelfRow) {
      // Not filed in the history: it came out of a list that already keeps it,
      // and a shelf you browse through would otherwise fill the history with
      // copies of itself.
      const s = shelf[+shelfRow.dataset.shelf];
      sfxName = s.name;
      setSound(s, { remember: false });
      return;
    }
    const row = e.target.closest('.sfx-row[data-n]');
    if (row) setSound(rollHistory[+row.dataset.n], { remember: false, from: +row.dataset.n });
  };

  $('sfx-list').oninput = e => {
    const nameEl = e.target.closest('[data-name]');
    if (nameEl) shelf[+nameEl.dataset.name].name = nameEl.value;
  };

  if (!window.sfxKeyHandlerInstalled) {
    document.addEventListener('keydown', onSfxKeyDown);
    window.sfxKeyHandlerInstalled = true;
    // Every trace is painted in the accent colour at draw time rather than
    // reading var(--accent) live, so a colour picked afterwards needs an
    // explicit repaint -- theme.js fires this event for exactly that, and
    // panels/instrument.js's sliders listen for the same reason.
    document.addEventListener('themechange', () => {
      if (!active) return;
      scheduleWave();
      renderVariations();
      renderSide();
    });
    // The main canvas is sized by its flex box, so a window resize changes how
    // many columns the waveform has to fill. The thumbnails are a fixed size
    // and do not care.
    window.addEventListener('resize', () => { if (active) scheduleWave(); });
  }

  render();
}
