// Who owns a keypress, given what currently has focus.
//
// The chrome is almost entirely sliders and checkboxes, and clicking one moves
// focus into it. A blanket "ignore keys while an INPUT has focus" guard would
// therefore kill the keyboard for as long as an instrument slider is focused --
// which is exactly when you want to keep hitting notes to hear what you changed.
// So the question is not what tag has focus, but what the focused control does
// with *this particular* key:
//
//   typingInField()    -- focus swallows printable characters, so no note key
//                         can be read as a note. Text inputs, textareas,
//                         selects (letters jump between options),
//                         contenteditable.
//   keyOwnedByFocus(e) -- focus has its own meaning for this particular key:
//                         arrows/Home/End/PageUp/PageDown on a slider, Space
//                         and Enter on a button/checkbox/color swatch. The
//                         editor must not act on those as well, or one
//                         keypress does two things (Space would toggle `loop`
//                         *and* start playback).
//
// Everything else falls through to the editor, whatever has focus -- notes,
// octave keys, ctrl+C/V, Delete. A slider keeps its arrow keys; the song keeps
// the rest of the keyboard.

const TEXT_INPUT = /^(|text|search|url|email|password|tel|number|date|time|datetime-local|month|week)$/;
const PRESSABLE = /^(button|submit|reset|checkbox|radio|color|file)$/;
// A slider's own keys, per the ARIA slider pattern browsers implement natively.
const SLIDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const PRESS_KEYS = new Set(['Space', 'Enter', 'NumpadEnter']);

export function typingInField() {
  const ae = document.activeElement;
  if (!ae) return false;
  if (ae.isContentEditable) return true;
  const tag = ae.tagName;
  // <input type=number> is in TEXT_INPUT: it takes typed digits, and digits are
  // both note keys (the chromatic sharps row) and pattern numbers.
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && TEXT_INPUT.test(ae.type));
}

export function keyOwnedByFocus(e) {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName, type = tag === 'INPUT' ? ae.type : '';
  if (type === 'range') return SLIDER_KEYS.has(e.code);
  if (tag === 'BUTTON' || PRESSABLE.test(type)) return PRESS_KEYS.has(e.code);
  // A focused link is activated by Enter (the About/help links in a dialog).
  if (tag === 'A' && ae.href) return e.code === 'Enter' || e.code === 'NumpadEnter';
  return false;
}

// The two together: true when the editor should leave this key alone entirely.
export const keyHandledByFocus = e => typingInField() || keyOwnedByFocus(e);
