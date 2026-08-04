// Voxby v2 song data model. No DOM, no editor state -- the same role
// engine.js plays for the SoundBox format, for the format described in
// plans/voxby-synth-v2.md and rendered by src/js/core/voxby.js.
//
// engine.js is NOT replaced. It still owns the SoundBox format: the binary
// importers, the sonant converters and the v1 JS export. This module reads it
// only through convertV1() below, which is how an old song gets into the new
// editor. Nothing here can write a SoundBox song.
//
// THE SHAPE
// ---------
//   {
//     rowLen, patternLen, endPattern, numChannels,
//     instruments: [ [ ...17 numbers ], ... ],   // voices, a song-level pool
//     channels: [ {
//       fx:  [ ...13 numbers ],   // the mixer strip
//       ins: 0,                   // default instrument index
//       seq: [ ... ],             // pattern number per song row, 0 = empty
//       pat: [ { n: [...], e: [...] }, ... ],
//     } ],
//   }
//
// In memory every array is dense and fixed-size, exactly as engine.js keeps
// the v1 song: every channel present, seq MAX_SONG_ROWS long, pat
// MAX_PATTERNS long. Export trims; import inflates back. The editor never has
// to test whether a slot exists.

import * as v1 from './engine.js';

export const MAX_SONG_ROWS = 500;
export const MAX_PATTERNS = 36;
export const MAX_CHANNELS = 16;
export const MAX_INSTRUMENTS = 64;

// Note names still map through this, unchanged from SoundBox, so the piano
// and the scale tables need no rework.
export const NOTE_OFFSET = 87;

// A note event of exactly 1 releases the column's voice. Real pitches start
// well above it, so nothing can collide.
export const NOTE_OFF = 1;

// --- Instrument parameters (the voice). 17 numbers. ------------------------
//
// ENV_SUSTAIN_LEVEL is deliberately not named ENV_SUSTAIN. In v1 that index
// held a sustain *time*; here it is a *level*, and a name that silently
// changed meaning would be a trap for every panel that reads it.
export const OSC1_WAVEFORM = 0,
    OSC1_VOL = 1,
    OSC1_SEMI = 2,
    OSC1_XENV = 3,
    OSC2_WAVEFORM = 4,
    OSC2_VOL = 5,
    OSC2_SEMI = 6,
    OSC2_DETUNE = 7,
    OSC2_XENV = 8,
    NOISE_VOL = 9,
    ENV_ATTACK = 10,
    ENV_DECAY = 11,
    ENV_SUSTAIN_LEVEL = 12,
    ENV_RELEASE = 13,
    ENV_EXP_DECAY = 14,
    ARP_CHORD = 15,
    ARP_SPEED = 16;
export const NUM_INSTR_PARAMS = 17;

// --- Channel effect parameters (the mixer strip). 13 numbers. --------------
export const LFO_WAVEFORM = 0,
    LFO_AMT = 1,
    LFO_FREQ = 2,
    LFO_FX_FREQ = 3,
    FX_FILTER = 4,
    FX_FREQ = 5,
    FX_RESONANCE = 6,
    FX_DIST = 7,
    FX_DRIVE = 8,
    FX_PAN_AMT = 9,
    FX_PAN_FREQ = 10,
    FX_DELAY_AMT = 11,
    FX_DELAY_TIME = 12;
export const NUM_FX_PARAMS = 13;

// --- Effect commands. Must match src/js/core/voxby.js. ---------------------
export const SLIDE_TO = 1,
    SLIDE = 2,
    VIBRATO = 3,
    TEMPO = 4,
    NOTE_DELAY = 5,
    GATE = 6,
    PARAM = 32;

// Display names, for the tracker's effect column and the help text.
export const CMD_NAMES = {
  [SLIDE_TO]: 'slide to',
  [SLIDE]: 'slide',
  [VIBRATO]: 'vibrato',
  [TEMPO]: 'tempo',
  [NOTE_DELAY]: 'delay',
  [GATE]: 'gate',
};

// The channel strip's parameter names, indexed the same as a channel's fx
// array. A PARAM command is written as PARAM + this index, so these double as
// the display names for those commands.
export const FX_NAMES = ['lfo wave', 'lfo amt', 'lfo freq', 'lfo->fx',
  'filter', 'freq', 'reso', 'dist', 'drive',
  'pan amt', 'pan freq', 'delay amt', 'delay time'];

// Three-character labels for the tracker's command column. Short enough that
// four voice columns of a channel still fit side by side.
const CMD_SHORT = {
  [SLIDE_TO]: 'SLD',
  [SLIDE]: 'BND',
  [VIBRATO]: 'VIB',
  [TEMPO]: 'TMP',
  [NOTE_DELAY]: 'DLY',
  [GATE]: 'GAT',
};

// What the tracker prints in a command cell. A PARAM writes a channel-strip
// parameter, and there are thirteen of those, so they are shown as P0..PC
// rather than being given thirteen more mnemonics.
export const cmdLabel = function (cmd) {
  if (!cmd) return '';
  if (cmd >= PARAM) {
    var i = cmd - PARAM;
    return i < NUM_FX_PARAMS ? 'P' + i.toString(16).toUpperCase() : '?';
  }
  return CMD_SHORT[cmd] || '?';
};

// The full name, for a tooltip or the status line.
export const cmdName = function (cmd) {
  if (!cmd) return '';
  if (cmd >= PARAM) {
    var i = cmd - PARAM;
    return i < NUM_FX_PARAMS ? FX_NAMES[i] : 'unknown parameter';
  }
  return CMD_NAMES[cmd] || 'unknown command';
};

// Which single key types which command in the tracker's command column.
// Deliberately not the first letter of every name: SLIDE_TO and SLIDE would
// both want S, so the free bend is typed as B for "bend".
export const CMD_KEYS = {
  KeyS: SLIDE_TO,
  KeyB: SLIDE,
  KeyV: VIBRATO,
  KeyT: TEMPO,
  KeyD: NOTE_DELAY,
  KeyG: GATE,
};

// Tempo is stored as a row length in samples, the same unit as song.rowLen,
// because that is what the player indexes rows with. The editor shows and
// accepts BPM, which is the only form a musician thinks in.
export const bpmOf = rowLen => (rowLen > 0 ? Math.round((60 * 44100 / 4) / rowLen) : 0);

export const calcSamplesPerRow = v1.calcSamplesPerRow;

//----------------------------------------------------------------------------
// Note events
//
// pitch | velocity << 8 | (instrument + 1) << 15
//
// A velocity or instrument field of 0 means "unchanged": the column keeps
// whatever it last used. That is what keeps an ordinary note a small number,
// which matters because the exported file is what ships.
//----------------------------------------------------------------------------

export const packNote = function (pitch, vel, ins) {
  return pitch | ((vel || 0) << 8) | (ins == null || ins < 0 ? 0 : (ins + 1) << 15);
};

export const pitchOf = n => n & 255;
export const velOf = n => (n >> 8) & 127;      // 0 = unchanged
export const insOf = n => (n >> 15) - 1;       // -1 = unchanged

// Replace one field of a packed note, keeping the other two. The tracker's
// note, instrument and velocity sub-columns are three separate cells over one
// stored number, so each has to be writable on its own.
//
// A pitch of 0 empties the whole event and a note-off carries no velocity or
// instrument, so both clear the other fields rather than leaving them stored
// where nothing will ever read them again.
export const withPitch = function (n, pitch) {
  if (!pitch || pitch === NOTE_OFF) return pitch || 0;
  return (pitch & 255) | (n & ~255);
};
export const withVel = function (n, vel) {
  if (!pitchOf(n) || pitchOf(n) === NOTE_OFF) return n;
  return (n & ~(127 << 8)) | ((vel & 127) << 8);
};
export const withIns = function (n, ins) {
  if (!pitchOf(n) || pitchOf(n) === NOTE_OFF) return n;
  return (n & 0x7fff) | (ins < 0 ? 0 : (ins + 1) << 15);
};

// Where a (row, column) lands in a pattern's arrays. A column is a voice slot,
// so these two indexings are parallel on purpose.
export const noteSlot = (patternLen, row, col) => row + col * patternLen;
export const fxSlot = (patternLen, row, col) => (row + col * patternLen) * 2;

//----------------------------------------------------------------------------
// Construction
//----------------------------------------------------------------------------

// "Softy", the SoundBox default preset, split into its two halves and given
// v2 envelope semantics: no decay, held at full level, so it sounds until a
// note-off. A percussive instrument sets ENV_SUSTAIN_LEVEL to 0 instead and
// then needs no note-off at all.
export const defaultInstrument = () =>
  [2, 100, 128, 0,   3, 201, 128, 0, 0,   0,   5, 0, 255, 58, 0,   0, 0];

export const defaultFx = () =>
  [0, 195, 6, 1,   2, 135, 0, 0, 32,   147, 6,   121, 6];

export const makeEmptyPattern = function (patternLen) {
  return {
    n: new Array(patternLen * 4).fill(0),
    e: new Array(patternLen * 8).fill(0),
  };
};

export const makeEmptyChannel = function (patternLen) {
  var pat = [];
  for (var i = 0; i < MAX_PATTERNS; i++) pat.push(makeEmptyPattern(patternLen));
  return {
    fx: defaultFx(),
    ins: 0,
    seq: new Array(MAX_SONG_ROWS).fill(0),
    pat: pat,
  };
};

export const makeNewSong = function () {
  var song = {
    rowLen: calcSamplesPerRow(120),
    patternLen: 32,
    endPattern: 0,
    numChannels: 1,
    instruments: [defaultInstrument()],
    channels: [],
  };
  for (var i = 0; i < MAX_CHANNELS; i++) song.channels.push(makeEmptyChannel(song.patternLen));
  song.channels[0].seq[0] = 1;   // one empty pattern to start on
  return song;
};

//----------------------------------------------------------------------------
// The instrument pool
//----------------------------------------------------------------------------

export const addInstrument = function (song, params) {
  if (song.instruments.length >= MAX_INSTRUMENTS) return -1;
  song.instruments.push(params ? params.slice() : defaultInstrument());
  return song.instruments.length - 1;
};

// Every place an instrument index can be written: a note's packed field, and a
// channel's default. Used both to refuse a removal and to renumber after one.
const eachInstrumentRef = function (song, fn) {
  for (var c = 0; c < MAX_CHANNELS; c++) {
    var ch = song.channels[c];
    fn(ch.ins, v => { ch.ins = v; });
    for (var p = 0; p < ch.pat.length; p++) {
      var n = ch.pat[p].n;
      for (var k = 0; k < n.length; k++) {
        var val = n[k];
        if (!val || val === NOTE_OFF) continue;
        var ins = insOf(val);
        if (ins < 0) continue;
        fn(ins, (function (arr, idx, raw) {
          return v => { arr[idx] = (raw & 0x7fff) | ((v + 1) << 15); };
        })(n, k, val));
      }
    }
  }
};

// Refused while any note still names it, the same rule the worldtool uses for
// removing an atlas: a removal that silently renumbered live references would
// corrupt the song with no error. Returns true when it removed.
export const removeInstrument = function (song, index) {
  if (song.instruments.length < 2) return false;
  var used = false;
  eachInstrumentRef(song, function (ins) { if (ins === index) used = true; });
  if (used) return false;
  song.instruments.splice(index, 1);
  // Everything above it shifts down by one.
  eachInstrumentRef(song, function (ins, set) { if (ins > index) set(ins - 1); });
  return true;
};

//----------------------------------------------------------------------------
// Derived ranges and resizing
//----------------------------------------------------------------------------

// endPattern and numChannels are derived from the sequence, not set by a
// control. Call after any sequencer edit.
export const recalcSongRanges = function (song) {
  var maxRow = 0, maxCol = 0;
  for (var i = 0; i < MAX_SONG_ROWS; i++) {
    for (var j = 0; j < MAX_CHANNELS; j++) {
      if (song.channels[j].seq[i] > 0) {
        maxCol = Math.max(maxCol, j);
        maxRow = i;
      }
    }
  }
  song.endPattern = maxRow;
  song.numChannels = maxCol + 1;
};

// Truncate or extend every pattern to a new row count, keeping the data that
// still fits. Both arrays are indexed per column, so each column's block moves
// as a unit rather than the whole array being sliced.
export const setPatternLength = function (song, length) {
  if (song.patternLen === length) return;
  var old = song.patternLen, keep = Math.min(old, length);
  for (var c = 0; c < MAX_CHANNELS; c++) {
    var ch = song.channels[c];
    for (var p = 0; p < ch.pat.length; p++) {
      var src = ch.pat[p], dst = makeEmptyPattern(length);
      for (var col = 0; col < 4; col++) {
        for (var k = 0; k < keep; k++) {
          dst.n[k + col * length] = src.n[k + col * old] || 0;
          dst.e[(k + col * length) * 2] = src.e[(k + col * old) * 2] || 0;
          dst.e[(k + col * length) * 2 + 1] = src.e[(k + col * old) * 2 + 1] || 0;
        }
      }
      ch.pat[p] = dst;
    }
  }
  song.patternLen = length;
};

// The highest pattern number a channel's sequence names. 0 when it plays none.
const maxPatternOf = function (ch) {
  var m = 0;
  for (var i = 0; i < MAX_SONG_ROWS; i++) if (ch.seq[i] > m) m = ch.seq[i];
  return m;
};

//----------------------------------------------------------------------------
// Export
//
// Same discipline as engine.js's songToJS: trailing zeros are cut, unused
// patterns and channels are dropped, and a skipped value is written as an
// array hole (`[1,,2]`). An empty effect column then costs two characters.
//----------------------------------------------------------------------------

const listText = function (arr, len) {
  var last = -1, i;
  for (i = 0; i < len; i++) if (arr[i]) last = i;
  var out = '';
  for (i = 0; i <= last; i++) {
    if (arr[i]) out += arr[i];
    if (i < last) out += ',';
  }
  return out;
};

export const songToJS = function (song) {
  var i, c, p, s = '';

  s += '// Exported by Voxby v2. Play it with src/js/core/voxby.js --\n';
  s += '// NOT with player-small.js or src/js/core/musicplayer.js, which read\n';
  s += '// the older SoundBox format.\n\n';
  s += 'export default {\n';

  s += '  instruments: [\n';
  for (i = 0; i < song.instruments.length; i++) {
    s += '    [' + song.instruments[i].join(',') + '],  // ' + i + '\n';
  }
  s += '  ],\n';

  s += '  channels: [\n';
  for (c = 0; c < song.numChannels; c++) {
    var ch = song.channels[c], maxPat = maxPatternOf(ch);
    s += '    { // channel ' + c + '\n';
    s += '      fx: [' + ch.fx.join(',') + '],\n';
    s += '      ins: ' + ch.ins + ',\n';
    s += '      seq: [' + listText(ch.seq, song.endPattern + 1) + '],\n';
    s += '      pat: [\n';
    for (p = 0; p < maxPat; p++) {
      s += '        {n: [' + listText(ch.pat[p].n, song.patternLen * 4) + '],\n';
      s += '         e: [' + listText(ch.pat[p].e, song.patternLen * 8) + ']}';
      s += p < maxPat - 1 ? ',\n' : '\n';
    }
    s += '      ],\n';
    s += '    }' + (c < song.numChannels - 1 ? ',' : '') + '\n';
  }
  s += '  ],\n';

  s += '  rowLen: ' + song.rowLen + ',       // samples per row, before any TEMPO\n';
  s += '  patternLen: ' + song.patternLen + ',    // rows per pattern\n';
  s += '  endPattern: ' + song.endPattern + ',    // last sequence row\n';
  s += '  numChannels: ' + song.numChannels + '\n';
  s += '};\n';
  return s;
};

//----------------------------------------------------------------------------
// Import
//
// The inverse of songToJS: inflate a trimmed literal back to the dense,
// fixed-size shape makeNewSong() produces and every panel assumes.
//----------------------------------------------------------------------------

const inflate = function (src, len) {
  var out = [], i, v;
  for (i = 0; i < len; i++) {
    v = Array.isArray(src) ? src[i] : undefined;
    out[i] = typeof v === 'number' && isFinite(v) ? v : 0;
  }
  return out;
};

export const normalizeSong = function (raw) {
  if (!raw || !Array.isArray(raw.instruments) || !Array.isArray(raw.channels)) return undefined;

  var patternLen = raw.patternLen > 0 ? raw.patternLen : 32;
  var song = {
    rowLen: raw.rowLen > 0 ? raw.rowLen : calcSamplesPerRow(120),
    patternLen: patternLen,
    endPattern: raw.endPattern >= 0 ? raw.endPattern : 0,
    numChannels: raw.numChannels > 0 ? raw.numChannels : 1,
    instruments: [],
    channels: [],
  };

  for (var i = 0; i < raw.instruments.length && i < MAX_INSTRUMENTS; i++) {
    song.instruments.push(inflate(raw.instruments[i], NUM_INSTR_PARAMS));
  }
  if (!song.instruments.length) song.instruments.push(defaultInstrument());

  for (var c = 0; c < MAX_CHANNELS; c++) {
    var src = raw.channels[c];
    var ch = makeEmptyChannel(patternLen);
    if (src) {
      ch.fx = inflate(src.fx, NUM_FX_PARAMS);
      ch.ins = typeof src.ins === 'number' ? src.ins : 0;
      ch.seq = inflate(src.seq, MAX_SONG_ROWS);
      if (Array.isArray(src.pat)) {
        for (var p = 0; p < src.pat.length && p < MAX_PATTERNS; p++) {
          ch.pat[p] = {
            n: inflate(src.pat[p] && src.pat[p].n, patternLen * 4),
            e: inflate(src.pat[p] && src.pat[p].e, patternLen * 8),
          };
        }
      }
    }
    song.channels.push(ch);
  }

  recalcSongRanges(song);
  return song;
};

// Evaluate an exported .js song file and normalize whatever it holds. Both
// formats arrive through here, because a file the user drops names neither:
// a v1 export has `songData`, a v2 one has `channels` and `instruments`, and
// that is enough to tell them apart. A v1 file is converted on the way in --
// this editor has no way to save one back, so the conversion is the import.
//
// The text is evaluated as a real ES module, which is why the open dialog
// warns about trusting the file.
export const songFromJSText = function (text) {
  // Older SoundBox builds exported `export default name = {...}`, which
  // assigns to an undeclared identifier -- a ReferenceError in a module (they
  // are always strict), so such a file won't even evaluate until the stray
  // name is dropped. Nothing ever read it.
  text = text.replace(/(export\s+default\s+)[A-Za-z_$][\w$]*\s*=\s*(?=[{[])/, '$1');
  var url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  return import(url).then(
    function (mod) { return fromAny(mod.default); },
    function () { return undefined; }
  ).then(function (song) {
    URL.revokeObjectURL(url);
    return song;
  });
};

// One song object, either format, as a v2 song.
export const fromAny = function (raw) {
  if (!raw) return undefined;
  if (Array.isArray(raw.songData)) return convertV1(v1.normalizeSong(raw));
  return normalizeSong(raw);
};

export const songFromJS = normalizeSong;

//----------------------------------------------------------------------------
// Share links
//
// Deflated, then base64url'd. The payload itself is trimmed JSON rather than a
// packed binary: a v2 binary format is worth writing once the format has
// stopped moving, not before.
//
// The deflate is not optional, though, and skipping it was a real bug for one
// revision. A link has to survive being pasted into a chat client, so it has a
// practical ceiling of a couple of thousand characters -- and raw base64 JSON
// puts a five-channel song an order of magnitude past it. JSON is highly
// repetitive, so deflate takes most of that back.
//
// fflate is the same global engine.js's binary format uses, loaded by
// index.html. The editor is a development tool, so a CDN script is acceptable
// here in a way it never is in a shipped game.
//----------------------------------------------------------------------------

const u8ToStr = function (u8) {
  var s = '';
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};
const strToU8 = function (s) {
  var u8 = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 255;
  return u8;
};

const trimList = function (arr, len) {
  var last = -1, i;
  for (i = 0; i < len; i++) if (arr[i]) last = i;
  return arr.slice(0, last + 1);
};

export const songToURLData = function (song) {
  var out = {
    r: song.rowLen, p: song.patternLen, e: song.endPattern, n: song.numChannels,
    i: song.instruments,
    c: [],
  };
  for (var c = 0; c < song.numChannels; c++) {
    var ch = song.channels[c], maxPat = maxPatternOf(ch), pat = [];
    for (var p = 0; p < maxPat; p++) {
      pat.push([trimList(ch.pat[p].n, song.patternLen * 4),
                trimList(ch.pat[p].e, song.patternLen * 8)]);
    }
    out.c.push([ch.fx, ch.ins, trimList(ch.seq, song.endPattern + 1), pat]);
  }
  var packed = u8ToStr(fflate.deflateSync(strToU8(JSON.stringify(out)), { level: 9 }));
  return btoa(packed)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const urlDataToSong = function (str) {
  var raw;
  try {
    var bytes = strToU8(atob(str.replace(/-/g, '+').replace(/_/g, '/')));
    raw = JSON.parse(u8ToStr(fflate.inflateSync(bytes)));
  } catch { return undefined; }
  if (!raw || !Array.isArray(raw.c)) return undefined;
  return normalizeSong({
    rowLen: raw.r, patternLen: raw.p, endPattern: raw.e, numChannels: raw.n,
    instruments: raw.i,
    channels: raw.c.map(function (ch) {
      return {
        fx: ch[0], ins: ch[1], seq: ch[2],
        pat: (ch[3] || []).map(function (q) { return { n: q[0], e: q[1] }; }),
      };
    }),
  });
};

//----------------------------------------------------------------------------
// Conversion from the SoundBox format
//
// v2 cannot read a v1 song, and its player never will. This is how an old
// song gets into the new editor instead: a one-way conversion, run at import.
//
// The envelope is the interesting part. A v1 note sounds for exactly
// attack + sustain + release samples, always. v2 holds a note until it is
// released, so the conversion sets the instrument to "no decay, held at full
// level" -- which is what v1's sustain phase is -- and gives every note a GATE
// command of the same length in rows. The result sounds the same.
//
// Two things do not survive, and the caller is told so:
//   - v1 effect commands that wrote a *voice* parameter (indices 0..15). v2
//     snapshots the voice at note-on, so there is nothing to write into.
//     Commands that wrote an effect parameter convert to PARAM.
//   - A PARAM that finds no free effect slot on its row. Every column already
//     carrying a GATE leaves nowhere to put it.
//----------------------------------------------------------------------------

export const convertV1 = function (old) {
  if (!old || !Array.isArray(old.songData)) return undefined;

  var song = {
    rowLen: old.rowLen,
    patternLen: old.patternLen,
    endPattern: old.endPattern,
    numChannels: old.numChannels,
    instruments: [],
    channels: [],
  };
  var dropped = { voiceAutomation: 0, noFreeSlot: 0 };
  var patternLen = old.patternLen;

  for (var c = 0; c < MAX_CHANNELS; c++) {
    var src = c < old.numChannels ? old.songData[c] : null;
    var ch = makeEmptyChannel(patternLen);

    // One instrument per real channel -- v1 has no pool, so that is exactly
    // what an old song carries. Unused channels point at instrument 0 rather
    // than padding the pool with copies of the default.
    if (!src) { song.channels.push(ch); continue; }
    ch.ins = song.instruments.length;
    var i = src.i;

    // Voice half: the oscillators pass straight through; the envelope becomes
    // "attack, no decay, hold at full, release".
    song.instruments.push([
      i[0], i[1], i[2], i[3],   i[4], i[5], i[6], i[7], i[8],   i[9],
      i[10], 0, 255, i[12], i[13],
      i[14], i[15],
    ]);
    // Effect half: v1 indices 16..28 are v2's channel strip, in the same order.
    ch.fx = i.slice(16, 29);

    // How long a v1 note sounds before its release, in rows. Deliberately not
    // rounded: a percussive instrument's note is a fraction of a row, and
    // rounding it up to a whole row would stretch every hit and make the song
    // much louder. GATE takes a fractional row count for exactly this reason.
    var held = i[10] * i[10] * 4 + i[11] * i[11] * 4;
    var gateRows = held / old.rowLen;

    for (var s = 0; s < MAX_SONG_ROWS; s++) ch.seq[s] = src.p[s] || 0;

    for (var p = 0; p < MAX_PATTERNS && p < src.c.length; p++) {
      var oldPat = src.c[p], newPat = ch.pat[p];
      for (var col = 0; col < 4; col++) {
        for (var row = 0; row < patternLen; row++) {
          var note = oldPat.n[row + col * patternLen];
          if (!note) continue;
          var slot = row + col * patternLen;
          newPat.n[slot] = note;                 // pitch only: v1 has no
                                                 // velocity or instrument field
          newPat.e[slot * 2] = GATE;
          newPat.e[slot * 2 + 1] = gateRows;
        }
      }

      // v1 effects: f[row] is the command, f[row + patternLen] its value.
      for (var row2 = 0; row2 < patternLen; row2++) {
        var cmd = oldPat.f[row2];
        if (!cmd) continue;
        var param = cmd - 1;
        if (param < 16) { dropped.voiceAutomation++; continue; }
        var put = -1;
        for (var col2 = 0; col2 < 4; col2++) {
          if (!newPat.e[(row2 + col2 * patternLen) * 2]) { put = col2; break; }
        }
        if (put < 0) { dropped.noFreeSlot++; continue; }
        newPat.e[(row2 + put * patternLen) * 2] = PARAM + (param - 16);
        newPat.e[(row2 + put * patternLen) * 2 + 1] = oldPat.f[row2 + patternLen] || 0;
      }
    }
    song.channels.push(ch);
  }

  recalcSongRanges(song);
  song.dropped = dropped;
  return song;
};
