// Piano roll panel: horizontal note grid showing time (rows) horizontally and
// pitch vertically. Alternative to the tracker view, toggled from the top bar.
//
// Shows ALL channels simultaneously with per-channel colors. The focused channel
// (state.selInstrument) renders at full opacity; others at 30% to provide
// context without clutter.
//
// Phase 1: Read-only rendering - draw the grid and all notes from all channels.
// Future phases: cursor, note entry, dragging, selection, clipboard.

import * as engine from '../engine.js';
import { state } from '../state.js';
import { keyHandledByFocus } from '../focus.js';

const $ = id => document.getElementById(id);

// Per-channel color palette (16 vibrant, distinguishable hues)
const CHANNEL_COLORS = [
  '#ff4444', '#44ff44', '#4444ff', '#ffff44',
  '#ff44ff', '#44ffff', '#ff8844', '#88ff44',
  '#8844ff', '#ffff88', '#ff88ff', '#88ffff',
  '#ff4488', '#88ff88', '#8888ff', '#ffaa44'
];

// Grid dimensions
const PIANO_KEY_WIDTH = 50;    // left margin for note labels
const CELL_WIDTH = 16;         // horizontal pixels per pattern row
let cellHeight = 9;            // vertical pixels per semitone (adjustable)
const OCTAVE_RANGE = [1, 8];   // which octaves to show (C1 to B8 = 96 semitones)

// Note names for labels
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function isBlackKey(pitch) {
  const n = pitch % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10; // C#, D#, F#, G#, A#
}

// Convert SoundBox note number to pitch (MIDI-style, C4 = 60)
// SoundBox's note numbers are offset by engine.NOTE_OFFSET (87)
function noteToPitch(note) {
  if (!note) return null;
  return note - engine.NOTE_OFFSET;
}

// Convert pitch back to SoundBox note number
function pitchToNote(pitch) {
  return pitch + engine.NOTE_OFFSET;
}

// Get the note name with octave (e.g. "C4", "A#6")
function pitchName(pitch) {
  const octave = Math.floor(pitch / 12);
  const name = NOTE_NAMES[pitch % 12];
  return name + octave;
}

export function initPianoRoll() {
  const panel = $('patterns-panel');
  if (!panel) return;

  // Create canvas container with flex wrapper and scrolling
  panel.innerHTML = `
    <div class="pianoroll-header">
      <h3 title="Time runs left to right, pitch bottom to top. Click an empty cell to place a note, right-click a note to delete it. The computer keys write their own pitch and pull the cursor onto it; Caps Lock writes the note the cursor is already on. Either way the row moves on by the edit step.">Piano Roll</h3>
      <label class="zoom-control" title="Vertical zoom: adjust row height">
        Zoom: <input id="pianoroll-zoom" type="range" min="6" max="20" step="1" value="${cellHeight}">
      </label>
      <div class="spacer"></div>
      <span class="hint" id="pianoroll-hint">All channels · Focused: Ch ${state.selInstrument + 1} · Pattern ${getCurrentPatternNum() || '—'}</span>
    </div>
    <div id="pianoroll-scroll" style="flex: 1; min-height: 0; overflow: auto; position: relative;">
      <canvas id="pianoroll-canvas"></canvas>
    </div>`;

  const canvas = $('pianoroll-canvas');
  const scroll = $('pianoroll-scroll');

  // Size canvas to grid dimensions (not viewport)
  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const gridHeight = numSemitones * cellHeight;
  const patternLen = state.song.patternLen;
  // Grid width: piano keys + pattern area, extend beyond viewport for scrolling
  const gridWidth = PIANO_KEY_WIDTH + patternLen * CELL_WIDTH + 200; // +200px extra space

  canvas.width = gridWidth;
  canvas.height = gridHeight;
  canvas.style.width = gridWidth + 'px';
  canvas.style.height = gridHeight + 'px';
  canvas.style.display = 'block';

  // Zoom control
  $('pianoroll-zoom').oninput = () => {
    const oldPitch = state.pianoRoll.cursorPitch;
    cellHeight = +$('pianoroll-zoom').value;
    initPianoRoll(); // re-render with new height
    scrollToPitch(oldPitch); // maintain view position
  };

  // Mouse handlers
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseup', onCanvasMouseUp);
  canvas.addEventListener('contextmenu', onCanvasRightClick);

  // Scroll to middle octave initially (C4 region)
  const middlePitch = 60; // C4
  scrollToPitch(middlePitch);

  // Keyboard handlers (installed once, check viewMode before acting)
  if (!window.pianoRollKeyHandlerInstalled) {
    document.addEventListener('keydown', onPianoRollKeyDown);
    document.addEventListener('keyup', onPianoRollKeyUp);
    window.pianoRollKeyHandlerInstalled = true;
  }

  render();
}

function scrollToPitch(pitch) {
  const scroll = $('pianoroll-scroll');
  if (!scroll) return;

  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const lowestPitch = OCTAVE_RANGE[0] * 12;
  const y = (numSemitones - 1 - (pitch - lowestPitch)) * cellHeight;

  // Center the pitch in the viewport
  scroll.scrollTop = y - scroll.clientHeight / 2 + cellHeight / 2;
}

// Convert canvas pixel coordinates to (row, pitch)
function canvasToGrid(x, y) {
  const canvas = $('pianoroll-canvas');
  if (!canvas) return null;

  const rect = canvas.getBoundingClientRect();
  const canvasX = x - rect.left;
  const canvasY = y - rect.top;

  const patternLen = state.song.patternLen;
  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const lowestPitch = OCTAVE_RANGE[0] * 12;

  // Check if within grid bounds
  if (canvasX < PIANO_KEY_WIDTH) return null;

  const row = Math.floor((canvasX - PIANO_KEY_WIDTH) / CELL_WIDTH);
  const pitch = lowestPitch + (numSemitones - 1 - Math.floor(canvasY / cellHeight));

  if (row < 0 || row >= patternLen || pitch < lowestPitch || pitch >= lowestPitch + numSemitones) {
    return null;
  }

  return { row, pitch };
}

let hoverCell = null;
let mousePos = null;
let dragStart = null;
let isDragging = false;

function onCanvasMouseMove(e) {
  const canvas = $('pianoroll-canvas');
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  hoverCell = canvasToGrid(e.clientX, e.clientY);

  // Handle dragging selection to move notes
  if (isDragging && state.pianoRoll.dragSelection && hoverCell) {
    const dx = e.clientX - state.pianoRoll.dragSelection.startX;
    const dy = e.clientY - state.pianoRoll.dragSelection.startY;

    state.pianoRoll.dragSelection.offsetRow = Math.round(dx / CELL_WIDTH);
    state.pianoRoll.dragSelection.offsetPitch = -Math.round(dy / cellHeight);
  }
  // Handle drag selection (rectangular)
  else if (isDragging && dragStart && hoverCell) {
    // Build selection from drag rectangle
    selectNotesInRect(dragStart.row, dragStart.pitch, hoverCell.row, hoverCell.pitch);
  }

  // Update hint text with hover info
  const hint = $('pianoroll-hint');
  if (hint && hoverCell) {
    hint.textContent = `Row ${hoverCell.row} · ${pitchName(hoverCell.pitch)} · Ch ${state.selInstrument + 1}`;
  } else if (hint) {
    hint.textContent = `All channels · Focused: Ch ${state.selInstrument + 1} · Pattern ${getCurrentPatternNum() || '—'}`;
  }

  render();
}

function onCanvasMouseDown(e) {
  // A click on the grid claims the keyboard back from the sequencer. Without
  // this, clicking a sequencer cell and then clicking a piano-roll cell to place
  // a note (both work by mouse regardless of editMode) left editMode stuck at
  // 'sequence' -- exactly the sticky-mode trap the first version of this fix was
  // for, just relocated: every note key afterwards would have gone to
  // seqGrid instead of the piano roll, with no visible reason why. See
  // onKeyDown's guard (tracker.js) and this module's own mirror of it. notify()
  // (rather than a bare assignment) so the sequencer's own render drops the
  // cursor highlight it draws for editMode 'sequence' -- this module never
  // touches that DOM itself.
  if (state.editMode === 'sequence') { state.editMode = 'pattern'; state.notify && state.notify(); }
  const cell = canvasToGrid(e.clientX, e.clientY);
  if (!cell) return;

  if (e.button !== 0) return; // only left button

  // Check if clicking on a selected note to start dragging
  const clickedSelected = state.pianoRoll.selectedNotes.some(n => n.row === cell.row && n.pitch === cell.pitch);

  if (clickedSelected && !e.shiftKey) {
    // Start dragging the selection
    state.pianoRoll.dragSelection = {
      startX: e.clientX,
      startY: e.clientY,
      offsetRow: 0,
      offsetPitch: 0
    };
    isDragging = true;
    dragStart = null;
    return;
  }

  if (e.shiftKey) {
    // Shift+click: extend selection by rectangular region (all enabled channels)
    dragStart = cell;
    isDragging = true;
  } else {
    // Clear selection and start new drag
    state.pianoRoll.selectedNotes = [];
    dragStart = cell;
    isDragging = true;
  }
}

function onCanvasMouseUp(e) {
  if (!isDragging) return;
  isDragging = false;

  const cell = canvasToGrid(e.clientX, e.clientY);

  // Finish dragging selection - commit the move
  if (state.pianoRoll.dragSelection) {
    const offset = state.pianoRoll.dragSelection;
    if (offset.offsetRow !== 0 || offset.offsetPitch !== 0) {
      moveSelectedNotes(offset.offsetRow, offset.offsetPitch);
    }
    state.pianoRoll.dragSelection = null;
    render();
    dragStart = null;
    return;
  }

  if (!cell || !dragStart) {
    dragStart = null;
    return;
  }

  // If drag was just a click (same cell), handle note placement/cursor
  if (dragStart.row === cell.row && dragStart.pitch === cell.pitch) {
    // Check if clicking on an existing note - if so, just move cursor
    const existingNote = getNoteAt(cell.row, cell.pitch);
    if (existingNote) {
      state.pianoRoll.selectedNotes = []; // clear selection
      state.pianoRoll.cursorRow = cell.row;
      state.pianoRoll.cursorPitch = cell.pitch;
      render();
      dragStart = null;
      return;
    }

    // If there are selected notes, just deselect them (don't place a note)
    if (state.pianoRoll.selectedNotes.length > 0) {
      state.pianoRoll.selectedNotes = [];
      state.pianoRoll.cursorRow = cell.row;
      state.pianoRoll.cursorPitch = cell.pitch;
      render();
      dragStart = null;
      return;
    }

    // Only allow note placement if focused channel is enabled
    if (!state.channelsEnabled[state.selInstrument]) {
      flashFeedback(`Channel ${state.selInstrument + 1} is muted - click its number in the sequencer to place notes`);
      dragStart = null;
      return;
    }

    // No selection and no note - place note at clicked position
    pushUndo();
    const note = pitchToNote(cell.pitch);
    if (placeNoteAtCursor(cell.row, note)) {
      // Update cursor to clicked position (no auto-scroll since user already positioned view)
      state.pianoRoll.cursorRow = cell.row;
      state.pianoRoll.cursorPitch = cell.pitch;
      render();
    }
  }

  dragStart = null;
}

function onCanvasRightClick(e) {
  e.preventDefault(); // prevent context menu

  const cell = canvasToGrid(e.clientX, e.clientY);
  if (!cell) return;

  // Delete note at clicked position from ANY enabled channel
  const note = pitchToNote(cell.pitch);
  deleteNoteAtAnyChannel(cell.row, note);

  // Move cursor to deleted position
  state.pianoRoll.cursorRow = cell.row;
  state.pianoRoll.cursorPitch = cell.pitch;
  render();
}

// Check if a note exists at (row, pitch) in the focused channel
function getNoteAt(row, pitch) {
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (!pn) return null;

  const pattern = state.song.songData[state.selInstrument].c[pn - 1];
  if (!pattern) return null;

  const note = pitchToNote(pitch);
  const patternLen = state.song.patternLen;

  for (let col = 0; col < 4; col++) {
    if (pattern.n[row + col * patternLen] === note) {
      return { col, note };
    }
  }
  return null;
}

// Place a note at the cursor row. Returns true if successful.
// preview: if true, plays the entire chord through the jammer (for mouse clicks)
function placeNoteAtCursor(row, note, preview = true) {
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (!pn) return false; // no pattern assigned

  const pattern = state.song.songData[state.selInstrument].c[pn - 1];
  if (!pattern) return false;

  const patternLen = state.song.patternLen;

  // Find first empty column at this row
  for (let col = 0; col < 4; col++) {
    if (!pattern.n[row + col * patternLen]) {
      pattern.n[row + col * patternLen] = note;
      state.notify && state.notify(); // mark dirty

      // Preview the entire chord (all notes at this row) - only for mouse clicks
      if (preview && state.previewNote) {
        const allNotes = [];
        for (let c = 0; c < 4; c++) {
          const n = pattern.n[row + c * patternLen];
          if (n) {
            const pitch = noteToPitch(n);
            const octave = Math.floor(pitch / 12);
            const offset = pitch % 12;
            allNotes.push(offset + (octave - state.octave) * 12);
          }
        }
        // Play all notes together
        for (const offset of allNotes) {
          state.previewNote(offset);
        }
      }
      return true;
    }
  }

  // All 4 columns full - flash feedback
  flashFeedback('All 4 note columns full at this row');
  return false;
}

// Step entry at the cursor cell (CapsLock): write the pitch the cursor is on,
// sound the row it lands in, and move on by the edit step -- the same distance a
// released note key advances by. Refuses the same cases the mouse does, and says
// which one it hit rather than doing nothing: an empty cell is the only place a
// note can go, and a second note at the same pitch would just be a doubled
// unison in another column.
function enterNoteAtCursorCell() {
  const row = state.pianoRoll.cursorRow, pitch = state.pianoRoll.cursorPitch;
  if (!state.channelsEnabled[state.selInstrument]) {
    flashFeedback(`Channel ${state.selInstrument + 1} is muted - click its number in the sequencer to place notes`);
    return;
  }
  if (!getCurrentPatternNum()) {
    flashFeedback('No pattern at this sequence row - assign one in the sequencer');
    return;
  }
  if (getNoteAt(row, pitch)) {
    flashFeedback(`${pitchName(pitch)} is already at the cursor`);
    return;
  }
  pushUndo();
  // preview left on, so this sounds like clicking the same cell does: the whole
  // row, the note you just added included.
  if (!placeNoteAtCursor(row, pitchToNote(pitch))) return; // flashes its own reason
  state.pianoRoll.cursorRow = Math.min(state.song.patternLen - 1, row + state.editStep);
  scrollCursorIntoView();
  render();
}

function flashFeedback(message) {
  const hint = $('pianoroll-hint');
  if (!hint) return;
  const original = hint.textContent;
  hint.textContent = message;
  hint.style.color = '#ff4444';
  setTimeout(() => {
    hint.textContent = original;
    hint.style.color = '';
  }, 1000);
}

function deleteNoteAtCursor() {
  const row = state.pianoRoll.cursorRow;
  const pitch = state.pianoRoll.cursorPitch;
  const note = pitchToNote(pitch);
  deleteNoteAt(row, note);
}

function deleteNoteAt(row, note) {
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (!pn) return;

  const pattern = state.song.songData[state.selInstrument].c[pn - 1];
  if (!pattern) return;

  const patternLen = state.song.patternLen;

  // Find and clear the note at this pitch
  for (let col = 0; col < 4; col++) {
    if (pattern.n[row + col * patternLen] === note) {
      pattern.n[row + col * patternLen] = 0;
      state.notify && state.notify();
      render();
      return;
    }
  }
}

function deleteNoteAtAnyChannel(row, note) {
  pushUndo();

  const patternLen = state.song.patternLen;
  let deleted = false;

  // Check all enabled channels for a note at this position
  for (let channel = 0; channel < engine.MAX_CHANNELS; channel++) {
    if (!state.channelsEnabled[channel]) continue;

    const pn = state.song.songData[channel].p[state.selRow];
    if (!pn) continue;

    const pattern = state.song.songData[channel].c[pn - 1];
    if (!pattern) continue;

    // Find and clear the note at this pitch
    for (let col = 0; col < 4; col++) {
      if (pattern.n[row + col * patternLen] === note) {
        pattern.n[row + col * patternLen] = 0;
        deleted = true;
        break; // Only delete one note per channel
      }
    }
  }

  if (deleted) {
    state.notify && state.notify();
  }
}

function selectNotesInRect(row0, pitch0, row1, pitch1) {
  const minRow = Math.min(row0, row1);
  const maxRow = Math.max(row0, row1);
  const minPitch = Math.min(pitch0, pitch1);
  const maxPitch = Math.max(pitch0, pitch1);

  const patternLen = state.song.patternLen;
  state.pianoRoll.selectedNotes = [];

  // Find all notes within rectangle across ALL ENABLED channels
  for (let channel = 0; channel < engine.MAX_CHANNELS; channel++) {
    // Skip disabled channels
    if (!state.channelsEnabled[channel]) continue;

    const pn = state.song.songData[channel].p[state.selRow];
    if (!pn) continue;

    const pattern = state.song.songData[channel].c[pn - 1];
    if (!pattern) continue;

    for (let row = minRow; row <= maxRow; row++) {
      for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
        const note = pitchToNote(pitch);
        for (let col = 0; col < 4; col++) {
          if (pattern.n[row + col * patternLen] === note) {
            state.pianoRoll.selectedNotes.push({ row, pitch, col, channel });
            break;
          }
        }
      }
    }
  }
}

function moveSelectedNotes(offsetRow, offsetPitch) {
  if (state.pianoRoll.selectedNotes.length === 0) return;

  pushUndo();

  const patternLen = state.song.patternLen;

  // Group by channel
  const byChannel = {};
  for (const n of state.pianoRoll.selectedNotes) {
    if (!byChannel[n.channel]) byChannel[n.channel] = [];
    byChannel[n.channel].push(n);
  }

  // Move notes within each channel
  const newSelection = [];
  for (const channel in byChannel) {
    const ch = +channel;
    const pn = state.song.songData[ch].p[state.selRow];
    if (!pn) continue;

    const pattern = state.song.songData[ch].c[pn - 1];
    if (!pattern) continue;

    // Store notes to move
    const notesToMove = byChannel[ch].map(n => ({
      row: n.row,
      pitch: n.pitch,
      col: n.col,
      note: pattern.n[n.row + n.col * patternLen]
    }));

    // Clear original positions
    for (const n of notesToMove) {
      pattern.n[n.row + n.col * patternLen] = 0;
    }

    // Place at new positions
    for (const n of notesToMove) {
      const newRow = n.row + offsetRow;
      const newPitch = n.pitch + offsetPitch;

      if (newRow < 0 || newRow >= patternLen) continue; // out of bounds

      const newNote = pitchToNote(newPitch);

      // Find empty column at new position
      for (let col = 0; col < 4; col++) {
        if (!pattern.n[newRow + col * patternLen]) {
          pattern.n[newRow + col * patternLen] = newNote;
          newSelection.push({ row: newRow, pitch: newPitch, col, channel: ch });
          break;
        }
      }
    }
  }

  state.pianoRoll.selectedNotes = newSelection;
  state.notify && state.notify();
}

function deleteSelection() {
  if (state.pianoRoll.selectedNotes.length === 0) return;

  pushUndo();

  const patternLen = state.song.patternLen;

  // Group by channel and delete from each
  for (const note of state.pianoRoll.selectedNotes) {
    const pn = state.song.songData[note.channel].p[state.selRow];
    if (!pn) continue;

    const pattern = state.song.songData[note.channel].c[pn - 1];
    if (!pattern) continue;

    pattern.n[note.row + note.col * patternLen] = 0;
  }

  state.pianoRoll.selectedNotes = [];
  state.notify && state.notify();
  render();
}

let pianoRollClipboard = null;

function copySelection() {
  if (state.pianoRoll.selectedNotes.length === 0) return;

  const selected = state.pianoRoll.selectedNotes;
  const minRow = Math.min(...selected.map(n => n.row));
  const minPitch = Math.min(...selected.map(n => n.pitch));

  const patternLen = state.song.patternLen;
  const notes = [];

  // Copy selected notes with relative positions AND channel info
  for (const n of selected) {
    const pn = state.song.songData[n.channel].p[state.selRow];
    if (!pn) continue;

    const pattern = state.song.songData[n.channel].c[pn - 1];
    if (!pattern) continue;

    const note = pattern.n[n.row + n.col * patternLen];
    notes.push({ row: n.row - minRow, pitch: n.pitch - minPitch, note, channel: n.channel });
  }

  pianoRollClipboard = { notes };

  flashFeedback(`Copied ${notes.length} note${notes.length !== 1 ? 's' : ''}`);
}

function pasteAtCursor() {
  if (!pianoRollClipboard) return;

  pushUndo();

  const patternLen = state.song.patternLen;
  const baseRow = state.pianoRoll.cursorRow;
  const basePitch = state.pianoRoll.cursorPitch;

  const newSelection = [];
  let placed = 0;

  // Paste to original channels (preserves arrangement)
  for (const noteData of pianoRollClipboard.notes) {
    const targetRow = baseRow + noteData.row;
    const targetPitch = basePitch + noteData.pitch;
    const channel = noteData.channel;

    if (targetRow < 0 || targetRow >= patternLen) continue; // out of bounds

    const pn = state.song.songData[channel].p[state.selRow];
    if (!pn) continue;

    const pattern = state.song.songData[channel].c[pn - 1];
    if (!pattern) continue;

    const targetNote = pitchToNote(targetPitch);

    // Find empty column
    for (let col = 0; col < 4; col++) {
      if (!pattern.n[targetRow + col * patternLen]) {
        pattern.n[targetRow + col * patternLen] = targetNote;
        newSelection.push({ row: targetRow, pitch: targetPitch, col, channel });
        placed++;
        break;
      }
    }
  }

  // Keep pasted notes selected so they can be moved
  state.pianoRoll.selectedNotes = newSelection;

  state.notify && state.notify();
  render();
  flashFeedback(`Pasted ${placed} note${placed !== 1 ? 's' : ''}`);
}

function selectAll() {
  const patternLen = state.song.patternLen;
  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const lowestPitch = OCTAVE_RANGE[0] * 12;

  selectNotesInRect(0, lowestPitch, patternLen - 1, lowestPitch + numSemitones - 1);
  render();
}

function pushUndo() {
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (!pn) return;

  const pattern = state.song.songData[state.selInstrument].c[pn - 1];
  if (!pattern) return;

  const newState = {
    notes: [...pattern.n],
    fx: [...pattern.f],
    channel: state.selInstrument,
    seqRow: state.selRow,
    pattern: pn
  };

  // Don't push if this state is identical to the last one (prevents duplicate entries)
  // Also prevents pushing the current state (which would make undo do nothing)
  if (state.undoStack.length > 0) {
    const last = state.undoStack[state.undoStack.length - 1];
    if (last.channel === newState.channel &&
        last.seqRow === newState.seqRow &&
        last.pattern === newState.pattern) {
      // Deep compare arrays
      let identical = true;
      if (last.notes.length !== newState.notes.length || last.fx.length !== newState.fx.length) {
        identical = false;
      } else {
        for (let i = 0; i < last.notes.length; i++) {
          if (last.notes[i] !== newState.notes[i]) {
            identical = false;
            break;
          }
        }
        if (identical) {
          for (let i = 0; i < last.fx.length; i++) {
            if (last.fx[i] !== newState.fx[i]) {
              identical = false;
              break;
            }
          }
        }
      }
      if (identical) return; // Skip duplicate
    }
  }

  state.undoStack.push(newState);

  // Clear redo stack when new action is performed
  state.redoStack = [];

  // Limit undo stack to 50 entries
  if (state.undoStack.length > 50) {
    state.undoStack.shift();
  }
}

function undo() {
  if (state.undoStack.length === 0) {
    flashFeedback('Nothing to undo');
    return;
  }

  // Save current state to redo stack before undoing
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (pn) {
    const pattern = state.song.songData[state.selInstrument].c[pn - 1];
    if (pattern) {
      state.redoStack.push({
        notes: [...pattern.n],
        fx: [...pattern.f],
        channel: state.selInstrument,
        seqRow: state.selRow,
        pattern: pn
      });
    }
  }

  const undoState = state.undoStack.pop();

  // Restore pattern state
  const pattern = state.song.songData[undoState.channel].c[undoState.pattern - 1];
  if (!pattern) {
    flashFeedback('Cannot undo - pattern missing');
    return;
  }

  pattern.n = [...undoState.notes];
  pattern.f = [...undoState.fx];

  state.pianoRoll.selectedNotes = [];
  state.notify && state.notify();
  render();
  flashFeedback('Undo');
}

function redo() {
  if (state.redoStack.length === 0) {
    flashFeedback('Nothing to redo');
    return;
  }

  // Save current state to undo stack before redoing
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (pn) {
    const pattern = state.song.songData[state.selInstrument].c[pn - 1];
    if (pattern) {
      state.undoStack.push({
        notes: [...pattern.n],
        fx: [...pattern.f],
        channel: state.selInstrument,
        seqRow: state.selRow,
        pattern: pn
      });
    }
  }

  const redoState = state.redoStack.pop();

  // Restore pattern state
  const pattern = state.song.songData[redoState.channel].c[redoState.pattern - 1];
  if (!pattern) {
    flashFeedback('Cannot redo - pattern missing');
    return;
  }

  pattern.n = [...redoState.notes];
  pattern.f = [...redoState.fx];

  state.pianoRoll.selectedNotes = [];
  state.notify && state.notify();
  render();
  flashFeedback('Redo');
}

function transposeSelection(semitones) {
  if (state.pianoRoll.selectedNotes.length === 0) return;

  pushUndo();

  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (!pn) return;

  const pattern = state.song.songData[state.selInstrument].c[pn - 1];
  if (!pattern) return;

  const patternLen = state.song.patternLen;
  const newSelection = [];

  // Transpose each selected note
  for (const note of state.pianoRoll.selectedNotes) {
    const oldNote = pattern.n[note.row + note.col * patternLen];
    if (!oldNote) continue;

    const newPitch = note.pitch + semitones;
    const newNote = pitchToNote(newPitch);

    // Update the note
    pattern.n[note.row + note.col * patternLen] = newNote;
    newSelection.push({ row: note.row, pitch: newPitch, col: note.col });
  }

  state.pianoRoll.selectedNotes = newSelection;
  state.notify && state.notify();
  render();

  const direction = semitones > 0 ? 'up' : 'down';
  const amount = Math.abs(semitones) === 12 ? '1 octave' : `${Math.abs(semitones)} semitone${Math.abs(semitones) > 1 ? 's' : ''}`;
  flashFeedback(`Transposed ${direction} ${amount}`);
}

// Track held note keys for chord detection
let heldNoteKeys = new Set();
let chordRowStart = null;

function onPianoRollKeyDown(e) {
  // Only handle keys when piano roll is active, and only when the sequencer
  // doesn't have the cursor -- tracker.js's onKeyDown owns editMode 'sequence'
  // wherever it's drawn (assigning a pattern number is its job, not this
  // module's), and its own guard is the exact mirror of this one so a keypress
  // is never claimed by both.
  if (state.viewMode !== 'pianoroll' || state.editMode === 'sequence') return;

  // Give up only the keys the focused control genuinely uses (see focus.js),
  // the same test tracker.js applies: a focused instrument slider keeps its
  // arrows, but note keys still reach the grid -- which is exactly when you want
  // to keep playing notes to hear what the slider changed.
  if (keyHandledByFocus(e)) return;

  const patternLen = state.song.patternLen;
  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const lowestPitch = OCTAVE_RANGE[0] * 12;
  let row = state.pianoRoll.cursorRow;
  let pitch = state.pianoRoll.cursorPitch;

  // CapsLock writes the cursor cell's own pitch. Every other note key names a
  // pitch of its own, so entering "the note I am looking at" meant working out
  // which key that pitch sits on -- easy to get wrong when the arrow keys are
  // what you are steering with. This is the piano roll's step-entry key: arrow
  // to a cell, press it, the cursor moves on by the edit step.
  if (e.code === 'CapsLock') {
    enterNoteAtCursorCell();
    e.preventDefault();
    return;
  }

  // Delete key - clear note at cursor or selection
  if (e.code === 'Delete' || e.code === 'Backspace') {
    if (state.pianoRoll.selectedNotes.length > 0) {
      deleteSelection();
    } else {
      deleteNoteAtCursor();
    }
    e.preventDefault();
    return;
  }

  // Transpose selection
  if (e.altKey && state.pianoRoll.selectedNotes.length > 0) {
    if (e.code === 'ArrowUp') {
      transposeSelection(e.shiftKey ? 12 : 1); // Shift = octave, plain = semitone
      e.preventDefault();
      return;
    }
    if (e.code === 'ArrowDown') {
      transposeSelection(e.shiftKey ? -12 : -1);
      e.preventDefault();
      return;
    }
  }

  // Clipboard and undo
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyC' && state.pianoRoll.selectedNotes.length > 0) {
      copySelection();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyV') {
      pasteAtCursor();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyA') {
      selectAll();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyZ' && e.shiftKey) {
      redo();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyZ' && !e.shiftKey) {
      undo();
      e.preventDefault();
      return;
    }
  }

  // Note entry via computer keyboard. The key -> semitone-offset map is the one
  // everything else uses (tracker.js's noteKeys(), reached through state.noteKeys
  // because tracker.js imports this module and the direct import would close a
  // cycle), so a scale layout or chord-follow remaps the piano roll exactly as it
  // remaps the tracker and the on-screen keys.
  if (state.previewNote && state.noteKeys && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const noteOffset = state.noteKeys()[e.code];
    if (noteOffset !== undefined && !e.repeat) {
      // Track this key as held
      heldNoteKeys.add(e.code);

      // If this is the first note key, remember the row for chord building and push undo
      if (heldNoteKeys.size === 1) {
        chordRowStart = row;
        pushUndo();
      }

      const note = state.previewNote(noteOffset); // preview and get the actual note number

      // Place note at the chord start row (not the current cursor row which may have moved)
      const targetRow = chordRowStart !== null ? chordRowStart : row;
      // Don't preview again - keyboard already previewed via state.previewNote above
      placeNoteAtCursor(targetRow, note, false);

      // The cursor follows the key you played. A note key names an absolute
      // pitch, so leaving the cursor behind put it somewhere the last note did
      // not come from -- and the next CapsLock or Delete acted there. Off-grid
      // pitches (past the drawn octaves) leave it where it is, since there is no
      // cell to move it to.
      const playedPitch = noteToPitch(note);
      if (playedPitch >= lowestPitch && playedPitch < lowestPitch + numSemitones) {
        state.pianoRoll.cursorPitch = playedPitch;
        scrollCursorIntoView();
      }

      // Don't advance the row yet - wait for all keys to be released
      render();
      e.preventDefault();
      return;
    }
  }

  switch (e.code) {
    case 'ArrowRight':
      row = e.ctrlKey ? patternLen - 1 : Math.min(patternLen - 1, row + 1);
      if (!e.shiftKey) {
        state.pianoRoll.selectedNotes = [];
      }
      // Clear chord state when cursor moves
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'ArrowLeft':
      row = e.ctrlKey ? 0 : Math.max(0, row - 1);
      if (!e.shiftKey) {
        state.pianoRoll.selectedNotes = [];
      }
      // Clear chord state when cursor moves
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'ArrowUp':
      pitch = e.ctrlKey ? lowestPitch + numSemitones - 1 : Math.min(lowestPitch + numSemitones - 1, pitch + 1);
      if (!e.shiftKey) {
        state.pianoRoll.selectedNotes = [];
      }
      // Clear chord state when cursor moves
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'ArrowDown':
      pitch = e.ctrlKey ? lowestPitch : Math.max(lowestPitch, pitch - 1);
      if (!e.shiftKey) {
        state.pianoRoll.selectedNotes = [];
      }
      // Clear chord state when cursor moves
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'Home':
      row = 0;
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'End':
      row = patternLen - 1;
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'PageUp':
      pitch = Math.min(lowestPitch + numSemitones - 1, pitch + 12); // up one octave
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    case 'PageDown':
      pitch = Math.max(lowestPitch, pitch - 12); // down one octave
      heldNoteKeys.clear();
      chordRowStart = null;
      e.preventDefault();
      break;
    default:
      return;
  }

  state.pianoRoll.cursorRow = row;
  state.pianoRoll.cursorPitch = pitch;
  scrollCursorIntoView();
  render();
}

function onPianoRollKeyUp(e) {
  // Only handle keys when piano roll is active
  if (state.viewMode !== 'pianoroll') return;

  // Membership in the held set, not the note map: the map can be remapped
  // between press and release (the scale or its root can change under a held
  // key), and a key that went down as a note has to come back up as one.
  if (heldNoteKeys.has(e.code)) {
    heldNoteKeys.delete(e.code);

    // If all note keys are released, advance cursor
    if (heldNoteKeys.size === 0 && chordRowStart !== null) {
      const patternLen = state.song.patternLen;
      state.pianoRoll.cursorRow = Math.min(patternLen - 1, chordRowStart + state.editStep);
      chordRowStart = null;
      render();
    }
  }
}

function scrollCursorIntoView() {
  const scroll = $('pianoroll-scroll');
  if (!scroll) return;

  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const lowestPitch = OCTAVE_RANGE[0] * 12;
  const y = (numSemitones - 1 - (state.pianoRoll.cursorPitch - lowestPitch)) * cellHeight;

  // Scroll only if cursor is outside viewport (with small margin to avoid jitter)
  const scrollTop = scroll.scrollTop;
  const scrollBottom = scrollTop + scroll.clientHeight;
  const MARGIN = 2; // px tolerance to prevent tiny scroll jumps

  if (y < scrollTop + MARGIN) {
    scroll.scrollTop = y;
  } else if (y + cellHeight > scrollBottom - MARGIN) {
    scroll.scrollTop = y + cellHeight - scroll.clientHeight;
  }
}

function getCurrentPatternNum() {
  return state.song.songData[state.selInstrument].p[state.selRow] || 0;
}

export function render() {
  const canvas = $('pianoroll-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  // Clear
  ctx.fillStyle = '#0d0e11'; // --bg0
  ctx.fillRect(0, 0, w, h);

  // Calculate grid dimensions
  const patternLen = state.song.patternLen;
  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;
  const lowestPitch = OCTAVE_RANGE[0] * 12; // C of lowest octave

  // Draw grid
  drawGrid(ctx, w, h, patternLen, numSemitones, lowestPitch);

  // Draw hover highlight
  if (hoverCell) {
    drawCellHighlight(ctx, hoverCell.row, hoverCell.pitch, lowestPitch, numSemitones, 'rgba(255, 255, 255, 0.05)');
  }

  // Draw playback cursor
  if (playbackRow >= 0 && playbackRow < patternLen) {
    const x = PIANO_KEY_WIDTH + playbackRow * CELL_WIDTH;
    const gridHeight = numSemitones * cellHeight;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(x, 0, CELL_WIDTH, gridHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + CELL_WIDTH / 2, 0);
    ctx.lineTo(x + CELL_WIDTH / 2, gridHeight);
    ctx.stroke();
  }

  // Draw full column indicators (rows where all 4 note columns are occupied in focused channel)
  drawFullColumnIndicators(ctx, patternLen, numSemitones, lowestPitch);

  // Draw all channels' notes
  for (let channel = 0; channel < engine.MAX_CHANNELS; channel++) {
    const pn = state.song.songData[channel].p[state.selRow];
    if (!pn) continue; // no pattern at this sequence row
    drawChannelNotes(ctx, channel, pn, patternLen, lowestPitch);
  }

  // Draw selected notes with highlight
  drawSelectedNotes(ctx, lowestPitch, numSemitones);

  // Draw marquee box while selecting
  if (isDragging && dragStart && !state.pianoRoll.dragSelection && hoverCell) {
    drawMarquee(ctx, dragStart, hoverCell, lowestPitch, numSemitones);
  }

  // Draw drag preview if moving selection
  if (state.pianoRoll.dragSelection) {
    drawDragPreview(ctx, lowestPitch, numSemitones);
  }

  // Draw cursor
  drawCellHighlight(ctx, state.pianoRoll.cursorRow, state.pianoRoll.cursorPitch, lowestPitch, numSemitones, 'rgba(255, 255, 255, 0.3)', true);

  // Draw cursor tooltip
  if (mousePos && hoverCell) {
    drawCursorTooltip(ctx, mousePos.x, mousePos.y, hoverCell.pitch);
  }
}

function drawCursorTooltip(ctx, x, y, pitch) {
  const text = pitchName(pitch);

  ctx.font = '12px monospace';
  ctx.textBaseline = 'top';

  // Position text offset from cursor
  const offsetX = 14;
  const offsetY = 14;
  let textX = x + offsetX;
  let textY = y + offsetY;

  // Keep text on screen
  const canvas = $('pianoroll-canvas');
  const metrics = ctx.measureText(text);
  if (textX + metrics.width > canvas.width) textX = x - metrics.width - 4;
  if (textY + 16 > canvas.height) textY = y - 20;

  // Text with shadow for readability
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillText(text, textX + 1, textY + 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, textX, textY);
}

function drawMarquee(ctx, start, end, lowestPitch, numSemitones) {
  const row0 = Math.min(start.row, end.row);
  const row1 = Math.max(start.row, end.row);
  const pitch0 = Math.min(start.pitch, end.pitch);
  const pitch1 = Math.max(start.pitch, end.pitch);

  const x = PIANO_KEY_WIDTH + row0 * CELL_WIDTH;
  const y = (numSemitones - 1 - (pitch1 - lowestPitch)) * cellHeight;
  const w = (row1 - row0 + 1) * CELL_WIDTH;
  const h = (pitch1 - pitch0 + 1) * cellHeight;

  // Marquee fill
  ctx.fillStyle = 'rgba(100, 150, 255, 0.1)';
  ctx.fillRect(x, y, w, h);

  // Marquee border (dashed)
  ctx.strokeStyle = 'rgba(100, 150, 255, 0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]); // reset dash
}

function drawSelectedNotes(ctx, lowestPitch, numSemitones) {
  for (const note of state.pianoRoll.selectedNotes) {
    const x = PIANO_KEY_WIDTH + note.row * CELL_WIDTH;
    const y = (numSemitones - 1 - (note.pitch - lowestPitch)) * cellHeight;

    // Bright outline in channel color (or blue if channel disabled)
    const isEnabled = state.channelsEnabled[note.channel];
    const color = isEnabled ? CHANNEL_COLORS[note.channel % CHANNEL_COLORS.length] : '#66ccff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL_WIDTH - 2, cellHeight - 2);
  }
}

function drawDragPreview(ctx, lowestPitch, numSemitones) {
  const offset = state.pianoRoll.dragSelection;

  for (const note of state.pianoRoll.selectedNotes) {
    const newRow = note.row + offset.offsetRow;
    const newPitch = note.pitch + offset.offsetPitch;

    const x = PIANO_KEY_WIDTH + newRow * CELL_WIDTH;
    const y = (numSemitones - 1 - (newPitch - lowestPitch)) * cellHeight;

    // Ghost preview of where notes will land
    ctx.fillStyle = 'rgba(100, 200, 255, 0.3)';
    drawRoundRect(ctx, x + 2, y + 2, CELL_WIDTH - 4, cellHeight - 4, 3);
  }
}

function drawFullColumnIndicators(ctx, patternLen, numSemitones, lowestPitch) {
  const pn = state.song.songData[state.selInstrument].p[state.selRow];
  if (!pn) return;

  const pattern = state.song.songData[state.selInstrument].c[pn - 1];
  if (!pattern) return;

  const gridX = PIANO_KEY_WIDTH;
  const gridHeight = numSemitones * cellHeight;

  // Check each row to see if all 4 columns are full
  for (let row = 0; row < patternLen; row++) {
    let count = 0;
    for (let col = 0; col < 4; col++) {
      if (pattern.n[row + col * patternLen]) count++;
    }

    if (count === 4) {
      // Draw vertical highlight for this column
      const x = gridX + row * CELL_WIDTH;
      ctx.fillStyle = 'rgba(255, 100, 100, 0.15)'; // subtle red tint
      ctx.fillRect(x, 0, CELL_WIDTH, gridHeight);
    }
  }
}

function drawCellHighlight(ctx, row, pitch, lowestPitch, numSemitones, color, isCursor = false) {
  const x = PIANO_KEY_WIDTH + row * CELL_WIDTH;
  const y = (numSemitones - 1 - (pitch - lowestPitch)) * cellHeight;

  if (isCursor) {
    // Cursor: outlined rectangle
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL_WIDTH - 2, cellHeight - 2);
  } else {
    // Hover: filled rectangle
    ctx.fillStyle = color;
    ctx.fillRect(x, y, CELL_WIDTH, cellHeight);
  }
}

function drawGrid(ctx, w, h, patternLen, numSemitones, lowestPitch) {
  const gridX = PIANO_KEY_WIDTH;
  const gridY = 0;
  const gridWidth = w - gridX; // fill entire width
  const gridHeight = numSemitones * cellHeight;
  const activeWidth = patternLen * CELL_WIDTH; // width of active pattern

  // Alternating row shading for white/black keys
  for (let i = 0; i < numSemitones; i++) {
    const pitch = lowestPitch + i;
    const y = gridY + (numSemitones - 1 - i) * cellHeight; // bottom to top

    // Active pattern area (lighter with more contrast)
    ctx.fillStyle = isBlackKey(pitch) ? '#16181e' : '#1d1f27';
    ctx.fillRect(gridX, y, activeWidth, cellHeight);

    // Beyond pattern area (darker)
    ctx.fillStyle = isBlackKey(pitch) ? '#0a0b0d' : '#0d0e11';
    ctx.fillRect(gridX + activeWidth, y, gridWidth - activeWidth, cellHeight);
  }

  // Vertical lines (beat markers) - only within active pattern
  ctx.strokeStyle = '#2a2c33';
  ctx.lineWidth = 1;
  for (let row = 0; row <= patternLen; row++) {
    const x = gridX + row * CELL_WIDTH;
    // Thicker line every beatRows
    if (row % state.beatRows === 0) {
      ctx.strokeStyle = '#3a3c44';
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = '#2a2c33';
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x + 0.5, gridY);
    ctx.lineTo(x + 0.5, gridY + gridHeight);
    ctx.stroke();
  }

  // Vertical line at pattern boundary (stronger visual separation)
  ctx.strokeStyle = '#4a4c55';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(gridX + activeWidth + 0.5, gridY);
  ctx.lineTo(gridX + activeWidth + 0.5, gridY + gridHeight);
  ctx.stroke();

  // Horizontal lines (octave markers) - extend full width
  ctx.strokeStyle = '#2a2c33';
  ctx.lineWidth = 1;
  for (let i = 0; i <= numSemitones; i++) {
    const pitch = lowestPitch + i;
    const y = gridY + (numSemitones - i) * cellHeight;
    // Thicker line at C notes, subtle line otherwise
    if (pitch % 12 === 0) {
      ctx.strokeStyle = '#4a4c55';
      ctx.lineWidth = 1.5;
    } else {
      ctx.strokeStyle = 'rgba(42, 44, 51, 0.4)';
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(gridX, y + 0.5);
    ctx.lineTo(w, y + 0.5); // extend to full width
    ctx.stroke();
  }

  // Piano key labels on the left
  ctx.fillStyle = '#8a8c97';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < numSemitones; i++) {
    const pitch = lowestPitch + i;
    const y = gridY + (numSemitones - 1 - i) * cellHeight + cellHeight / 2;
    // Only label C notes to avoid clutter
    if (pitch % 12 === 0) {
      ctx.fillText(pitchName(pitch), PIANO_KEY_WIDTH - 6, y);
    }
  }
}

function drawChannelNotes(ctx, channel, patternNum, patternLen, lowestPitch) {
  const pattern = state.song.songData[channel].c[patternNum - 1];
  if (!pattern) return;

  const isFocused = channel === state.selInstrument;
  const isEnabled = state.channelsEnabled[channel];

  // Disabled channels are grey and very dim
  const color = isEnabled ? CHANNEL_COLORS[channel % CHANNEL_COLORS.length] : '#888888';
  const opacity = !isEnabled ? 0.15 : (isFocused ? 1.0 : 0.3);

  // Parse the color to apply opacity
  const rgb = hexToRgb(color);
  ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;

  const gridX = PIANO_KEY_WIDTH;
  const numSemitones = (OCTAVE_RANGE[1] - OCTAVE_RANGE[0] + 1) * 12;

  // Iterate through all 4 note columns
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < patternLen; row++) {
      const note = pattern.n[row + col * patternLen];
      if (!note) continue;

      const pitch = noteToPitch(note);
      if (pitch < lowestPitch || pitch >= lowestPitch + numSemitones) continue; // out of range

      const x = gridX + row * CELL_WIDTH;
      const y = (numSemitones - 1 - (pitch - lowestPitch)) * cellHeight;

      // Draw note block (rounded rectangle)
      drawRoundRect(ctx, x + 2, y + 2, CELL_WIDTH - 4, cellHeight - 4, 3);
    }
  }
}

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
}

// Export for tracker.js to call when view mode changes
export function refreshPianoRoll() {
  if (state.viewMode !== 'pianoroll') return;
  render();
}

// Track playback position for drawing
let playbackRow = -1;

// Called from main.js during playback (same as tracker's followPlayback)
export function followPlaybackPianoRoll(row) {
  if (state.viewMode !== 'pianoroll') return;
  playbackRow = row;
  render();
}

export function stopFollowingPianoRoll() {
  playbackRow = -1;
  if (state.viewMode === 'pianoroll') render();
}
