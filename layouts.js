// Physical-keyboard layouts (plans/soundbox-revamp.md Stage E.15). Pure data
// and one detection call -- no DOM, no state, same shape as scales.js.
//
// What this does and doesn't change is the whole design decision, so: note
// entry stays keyed by `KeyboardEvent.code` (see panels/tracker.js's NOTE_KEYS
// and scales.js's ROW_BOTTOM/ROW_TOP), which is a *physical* key position on a
// US-QWERTY reference layout no matter what layout the OS has active. That is
// exactly what a music keyboard wants: playing is positional, so the two note
// rows stay in the same two physical rows and the same fingering works on
// every layout. What breaks on a non-QWERTY layout is only the little
// .kb-label hints on the on-screen piano, which used to derive the printed
// character straight from the code ('KeyZ' -> "Z") and so lied to anyone whose
// Z key isn't where QWERTY's is. These tables fix the labels, nothing else.
//
// Only the codes note entry can reach need entries; anything missing falls
// back to the US-QWERTY reading of the code itself (see charFor).

// German/Swiss QWERTZ: Z and Y are swapped, and the punctuation right of L
// differs. The rest of the alphabet sits where QWERTY has it.
const QWERTZ = {
  KeyZ: 'Y', KeyY: 'Z',
  Semicolon: 'Ö', Quote: 'Ä', BracketLeft: 'Ü', Minus: 'ß', Slash: '-',
};

// Dvorak moves nearly everything, which is why deriving a label from the code
// is worst here -- a Dvorak player pressing "the key labelled ;" plays C.
const DVORAK = {
  KeyQ: '\'', KeyW: ',', KeyE: '.', KeyR: 'P', KeyT: 'Y',
  KeyY: 'F', KeyU: 'G', KeyI: 'C', KeyO: 'R', KeyP: 'L',
  KeyA: 'A', KeyS: 'O', KeyD: 'E', KeyF: 'U', KeyG: 'I',
  KeyH: 'D', KeyJ: 'H', KeyK: 'T', KeyL: 'N', Semicolon: 'S',
  KeyZ: ';', KeyX: 'Q', KeyC: 'J', KeyV: 'K', KeyB: 'X',
  KeyN: 'B', KeyM: 'M', Comma: 'W', Period: 'V', Slash: 'Z',
};

// [id, label]. 'auto' asks the browser what the OS layout actually is (see
// detectLayout) and is the default, since getting it right without being told
// beats a setting nobody knows to change.
export const LAYOUTS = [
  ['auto', 'Auto'],
  ['qwerty', 'QWERTY'],
  ['qwertz', 'QWERTZ'],
  ['dvorak', 'Dvorak'],
];

export const LAYOUT_TABLES = { qwerty: {}, qwertz: QWERTZ, dvorak: DVORAK };

// The real thing, where it exists: navigator.keyboard.getLayoutMap() reports
// the character each physical key currently produces, so 'auto' needs no
// guessing and covers layouts with no table above (AZERTY, Colemak, ...).
// Chromium-only and secure-context-only -- http://localhost counts, a plain-http
// domain later would not -- so a null return here is normal and means "fall
// back to the QWERTY reading", not an error.
export async function detectLayout() {
  try {
    const map = await navigator.keyboard.getLayoutMap();
    const table = {};
    for (const [code, ch] of map) table[code] = ch.toUpperCase();
    return table;
  } catch {
    return null;
  }
}

// The character printed on the physical key `code`, per `table`. The fallback
// is the code's own US-QWERTY reading, which is what this always did.
export function charFor(code, table) {
  if (table && table[code]) return table[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return { Comma: ',', Period: '.', Semicolon: ';', Slash: '/', Quote: '\'', Minus: '-', Equal: '=' }[code] || '';
}
