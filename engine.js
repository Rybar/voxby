/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2014 Marcus Geelnard
*
* This file is part of SoundBox.
*
* SoundBox is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* SoundBox is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with SoundBox.  If not, see <http://www.gnu.org/licenses/>.
*
*/

//------------------------------------------------------------------------------
// Song/instrument data model: binary (de)serialization for the SoundBox and
// Sonant formats, plus the JS export used by src/js/sounds/. Extracted
// behavior-preserving from gui.js (plans/soundbox-revamp.md Phase 3 Stage A)
// -- no DOM references, pure functions over plain song/instrument objects.
// gui.js's UI chrome still owns mSong and every DOM-facing concern; it now
// calls into this module instead of defining these functions itself.
//
// Depends on three globals still supplied by their own (still-classic-script)
// files, exactly as gui.js relied on them before: gInstrumentPresets
// (presets.js), rle_encode/rle_decode (rle.js), RawDeflate (third_party/
// deflate.js + inflate.js).
//------------------------------------------------------------------------------

export const MAX_SONG_ROWS = 500;
export const MAX_PATTERNS = 36;
export const MAX_CHANNELS = 16;

// gui.js's playNote() (piano-key/on-screen-keyboard note entry) offsets its
// 0-based key/octave arithmetic by this to land in SoundBox's actual note
// number space. Shared by panels/tracker.js's pattern note entry and
// panels/keyboard.js's live preview so the two stay in exact agreement.
export const NOTE_OFFSET = 87;

// Instrument property indices
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
    ENV_SUSTAIN = 11,
    ENV_RELEASE = 12,
    ENV_EXP_DECAY = 13,

    ARP_CHORD = 14,
    ARP_SPEED = 15,

    LFO_WAVEFORM = 16,
    LFO_AMT = 17,
    LFO_FREQ = 18,
    LFO_FX_FREQ = 19,

    FX_FILTER = 20,
    FX_FREQ = 21,
    FX_RESONANCE = 22,
    FX_DIST = 23,
    FX_DRIVE = 24,
    FX_PAN_AMT = 25,
    FX_PAN_FREQ = 26,
    FX_DELAY_AMT = 27,
    FX_DELAY_TIME = 28;

// Number of instrument parameters, i.e. the length of an instrument's `i`
// array (songToJS emits exactly these, in index order).
export const NUM_INSTR_PARAMS = FX_DELAY_TIME + 1;

//------------------------------------------------------------------------------
// Local classes for easy access to binary data
//------------------------------------------------------------------------------

var CBinParser = function (d) {
  var mData = d;
  var mPos = 0;

  this.getUBYTE = function () {
    return mData.charCodeAt(mPos++) & 255;
  };

  this.getUSHORT = function () {
    var l = (mData.charCodeAt(mPos) & 255) |
            ((mData.charCodeAt(mPos + 1) & 255) << 8);
    mPos += 2;
    return l;
  };

  this.getULONG = function () {
    var l = (mData.charCodeAt(mPos) & 255) |
            ((mData.charCodeAt(mPos + 1) & 255) << 8) |
            ((mData.charCodeAt(mPos + 2) & 255) << 16) |
            ((mData.charCodeAt(mPos + 3) & 255) << 24);
    mPos += 4;
    return l;
  };

  this.getFLOAT = function () {
    var l = this.getULONG();
    if (l == 0) return 0;
    var s = l & 0x80000000;                       // Sign
    var e = (l >> 23) & 255;                      // Exponent
    var m = 1 + ((l & 0x007fffff) / 0x00800000);  // Mantissa
    var x = m * Math.pow(2, e - 127);
    return s ? -x : x;
  };

  this.getTail = function () {
    var str = mData.slice(mPos);
    mPos = mData.length;
    return str;
  };
};

var CBinWriter = function () {
  var mData = "";

  this.putUBYTE = function (x) {
    mData += String.fromCharCode(x);
  };

  this.putUSHORT = function (x) {
    mData += String.fromCharCode(
               x & 255,
               (x >> 8) & 255
             );
  };

  this.putULONG = function (x) {
    mData += String.fromCharCode(
               x & 255,
               (x >> 8) & 255,
               (x >> 16) & 255,
               (x >> 24) & 255
             );
  };

  this.putFLOAT = function (x) {
    var l = 0;
    if (x != 0)
    {
      var s = 0;
      if (x < 0) s = 0x80000000, x = -x;
      var e = 127 + 23;
      while (x < 0x00800000)
      {
        x *= 2;
        e--;
      }
      while (x >= 0x01000000)
      {
        x /= 2;
        e++;
      }
      l = s | ((e & 255) << 23) | (x & 0x007fffff);
    }
    this.putULONG(l);
  };

  this.append = function (x) {
    mData += x;
  };

  this.getData = function () {
    return mData;
  };
};

var makeFourCC = function (fourChars) {
  return (fourChars.charCodeAt(3) << 24) | (fourChars.charCodeAt(2) << 16) |
         (fourChars.charCodeAt(1) << 8) | fourChars.charCodeAt(0);
};

//------------------------------------------------------------------------------
// Song import/export functions
//------------------------------------------------------------------------------

export const calcSamplesPerRow = function (bpm) {
  return Math.round((60 * 44100 / 4) / bpm);
};

export const makeEmptyChannel = function (patternLen) {
  // NOTE: gui.js's original version of this function left these five as
  // implicit globals -- harmless there only because a stray `"use strict"`
  // after the leading include() calls never actually took effect (it's not
  // first in the file, so it's not a directive prologue and the whole
  // script stayed sloppy-mode). An ES module is always strict, so these
  // need real declarations here.
  var instr, i, j, k, col;
  instr = {};
  instr.i = [];

  // Select the default instrument from the presets
  var defaultInstr;
  for (i = 0; i < gInstrumentPresets.length; ++i) {
    if (gInstrumentPresets[i].i) {
      defaultInstr = gInstrumentPresets[i];
      break;
    }
  }

  // Copy the default instrument
  for (j = 0; j <= defaultInstr.i.length; ++j) {
    instr.i[j] = defaultInstr.i[j];
  }

  // Sequence
  instr.p = [];
  for (j = 0; j < MAX_SONG_ROWS; j++)
    instr.p[j] = 0;

  // Patterns
  instr.c = [];
  for (j = 0; j < MAX_PATTERNS; j++)
  {
    col = {};
    col.n = [];
    for (k = 0; k < patternLen * 4; k++)
      col.n[k] = 0;
    col.f = [];
    for (k = 0; k < patternLen * 2; k++)
      col.f[k] = 0;
    instr.c[j] = col;
  }

  return instr;
};

export const makeNewSong = function () {
  var song = {}, i, j, k, instr, col;

  // Row length
  song.rowLen = calcSamplesPerRow(120);

  // Last pattern to play
  song.endPattern = 0;

  // Rows per pattern
  song.patternLen = 32;

  // Number of channels
  song.numChannels = 1;

  // All instruments
  song.songData = [];
  for (i = 0; i < MAX_CHANNELS; i++) {
    song.songData[i] = makeEmptyChannel(song.patternLen);
  }

  // Make a first empty pattern
  song.songData[0].p[0] = 1;

  return song;
};

// Scans every channel/row for the highest non-empty sequencer row and
// channel, and updates song.endPattern/song.numChannels to match -- these
// two fields are otherwise-derived metadata (not something a UI control
// sets directly), same as gui.js's updateSongRanges(), minus that
// function's updateSongSpeed() call (a UI-side BPM-field refresh with
// nothing to do with the song data itself; tools/soundbox/panels/tracker.js,
// Stage D, calls this after every sequencer edit and callers needing the
// BPM field refreshed do that themselves).
export const recalcSongRanges = function (song) {
  var maxRow = 0, maxCol = 0;
  for (var i = 0; i < MAX_SONG_ROWS; i++) {
    for (var j = 0; j < MAX_CHANNELS; j++) {
      if (song.songData[j].p[i] > 0) {
        maxCol = Math.max(maxCol, j);
        maxRow = i;
      }
    }
  }
  song.endPattern = maxRow;
  song.numChannels = maxCol + 1;
};

// Truncates/extends every channel's patterns to a new row count, preserving
// existing note/fx data -- ported from gui.js's setPatternLength() (Stage D
// tracker.js's Rows-per-pattern control), minus that function's leading
// stopAudio() call (playing audio would desync from the changed pattern
// length; that's a UI/player concern the caller handles, not song data).
export const setPatternLength = function (song, length) {
  if (song.patternLen === length) return;
  for (var i = 0; i < MAX_CHANNELS; i++) {
    for (var j = 0; j < MAX_PATTERNS; j++) {
      var col = song.songData[i].c[j];
      var notes = [], fx = [];
      for (var k = 0; k < 4 * length; k++) notes[k] = 0;
      for (var k = 0; k < 2 * length; k++) fx[k] = 0;
      for (var k = 0; k < Math.min(song.patternLen, length); k++) {
        notes[k] = col.n[k];
        notes[k + length] = col.n[k + song.patternLen];
        notes[k + 2 * length] = col.n[k + 2 * song.patternLen];
        notes[k + 3 * length] = col.n[k + 3 * song.patternLen];
        fx[k] = col.f[k];
        fx[k + length] = col.f[k + song.patternLen];
      }
      col.n = notes;
      col.f = fx;
    }
  }
  song.patternLen = length;
};

var putInstrument = function(bin,instrI)
{
  // Oscillator 1
  bin.putUBYTE(instrI[OSC1_WAVEFORM]);
  bin.putUBYTE(instrI[OSC1_VOL]);
  bin.putUBYTE(instrI[OSC1_SEMI]);
  bin.putUBYTE(instrI[OSC1_XENV]);

  // Oscillator 2
  bin.putUBYTE(instrI[OSC2_WAVEFORM]);
  bin.putUBYTE(instrI[OSC2_VOL]);
  bin.putUBYTE(instrI[OSC2_SEMI]);
  bin.putUBYTE(instrI[OSC2_DETUNE]);
  bin.putUBYTE(instrI[OSC2_XENV]);

  // Noise oscillator
  bin.putUBYTE(instrI[NOISE_VOL]);

  // Envelope
  bin.putUBYTE(instrI[ENV_ATTACK]);
  bin.putUBYTE(instrI[ENV_SUSTAIN]);
  bin.putUBYTE(instrI[ENV_RELEASE]);
  bin.putUBYTE(instrI[ENV_EXP_DECAY]);

  // Arpeggio
  bin.putUBYTE(instrI[ARP_CHORD]);
  bin.putUBYTE(instrI[ARP_SPEED]);

  // LFO
  bin.putUBYTE(instrI[LFO_WAVEFORM]);
  bin.putUBYTE(instrI[LFO_AMT]);
  bin.putUBYTE(instrI[LFO_FREQ]);
  bin.putUBYTE(instrI[LFO_FX_FREQ]);

  // Effects
  bin.putUBYTE(instrI[FX_FILTER]);
  bin.putUBYTE(instrI[FX_FREQ]);
  bin.putUBYTE(instrI[FX_RESONANCE]);
  bin.putUBYTE(instrI[FX_DIST]);
  bin.putUBYTE(instrI[FX_DRIVE]);
  bin.putUBYTE(instrI[FX_PAN_AMT]);
  bin.putUBYTE(instrI[FX_PAN_FREQ]);
  bin.putUBYTE(instrI[FX_DELAY_AMT]);
  bin.putUBYTE(instrI[FX_DELAY_TIME]);
}

var compress = function(unpackedData)
{
  // Pack the song data
  // FIXME: To avoid bugs, we try different compression methods here until we
  // find something that works (this should not be necessary).
  var packedData, testData, compressionMethod = 0, i;
  for (i = 9; i > 0; i--) {
    packedData = RawDeflate.deflate(unpackedData, i);
    testData = RawDeflate.inflate(packedData);
    if (unpackedData === testData) {
      compressionMethod = 2;
      break;
    }
  }
  if (compressionMethod == 0) {
    packedData = rle_encode(unpackedData);
    testData = rle_decode(packedData);
    if (unpackedData === testData)
      compressionMethod = 1;
    else
      packedData = unpackedData;
  }
  // method:
  //  0: none
  //  1: RLE
  //  2: DEFLATE
  return {method:compressionMethod,data:packedData};
}

var uncompress = function(method,packedData)
{
  switch (method) {
    default:
    case 0:
      return packedData;
    case 1:
      return rle_decode(packedData);
    case 2:
      return RawDeflate.inflate(packedData);
  }
}

export const songToBin = function (song) {
  var bin = new CBinWriter();

  // Row length (i.e. song speed)
  bin.putULONG(song.rowLen);

  // Last pattern to play
  bin.putUSHORT(song.endPattern);

  // Rows per pattern
  bin.putUBYTE(song.patternLen);

  // Number of channels
  bin.putUBYTE(song.numChannels);

  // All instruments
  var i, j, k, instr, col;
  for (i = 0; i < song.numChannels; i++) {
    instr = song.songData[i];

    putInstrument(bin,instr.i);

    // Patterns
    for (j = 0; j <= song.endPattern; j++)
      bin.putUBYTE(instr.p[j]);

    // Columns
    for (j = 0; j < MAX_PATTERNS; j++) {
      col = instr.c[j];
      for (k = 0; k < song.patternLen * 4; k++)
        bin.putUBYTE(col.n[k]);
      for (k = 0; k < song.patternLen * 2; k++)
        bin.putUBYTE(col.f[k]);
    }
  }

  var compressedData = compress(bin.getData());

  // Create a new binary stream - this is the actual file
  bin = new CBinWriter();

  // Signature
  bin.putULONG(makeFourCC("SBox"));

  // Format version
  bin.putUBYTE(14);

  // Compression method
  bin.putUBYTE(compressedData.method);

  // Append packed data
  bin.append(compressedData.data);

  return bin.getData();
};

export const soundboxBinToSong = function (d) {
  var bin = new CBinParser(d);
  var song = {};

  // Signature
  var signature = bin.getULONG();

  // Format version
  var version = bin.getUBYTE();

  // Check if this is a SoundBox song
  if (signature != makeFourCC("SBox") || (version < 1 || version > 14))
    return undefined;

  if (version >= 8) {
    // Get compression method
    var compressionMethod = bin.getUBYTE();

    // Unpack song data
    var packedData = bin.getTail();
    var unpackedData = uncompress(compressionMethod,packedData);
    bin = new CBinParser(unpackedData);
  }

  // Row length
  song.rowLen = bin.getULONG();

  // Last pattern to play
  if (version >= 12)
    song.endPattern = bin.getUSHORT();
  else
    song.endPattern = bin.getUBYTE() + 2;

  // Number of rows per pattern
  if (version >= 10)
    song.patternLen = bin.getUBYTE();
  else
    song.patternLen = 32;

  // Number of channels
  if (version >= 12)
    song.numChannels = bin.getUBYTE();
  else
    song.numChannels = 8;

  // All instruments
  song.songData = [];
  var i, j, k, instr, col;
  for (i = 0; i < song.numChannels; i++) {
    instr = {};
    instr.i = [];

    // Oscillator 1
    if (version < 6) {
      instr.i[OSC1_SEMI] = bin.getUBYTE();
      instr.i[OSC1_XENV] = 64 * bin.getUBYTE();
      instr.i[OSC1_VOL] = bin.getUBYTE();
      instr.i[OSC1_WAVEFORM] = bin.getUBYTE();
    }
    else {
      instr.i[OSC1_WAVEFORM] = bin.getUBYTE();
      instr.i[OSC1_VOL] = bin.getUBYTE();
      instr.i[OSC1_SEMI] = bin.getUBYTE();
      instr.i[OSC1_XENV] = version < 13 ? 64 * bin.getUBYTE() : bin.getUBYTE();
    }

    // Oscillator 2
    if (version < 6) {
      instr.i[OSC2_SEMI] = bin.getUBYTE();
      instr.i[OSC2_DETUNE] = bin.getUBYTE();
      instr.i[OSC2_XENV] = 64 * bin.getUBYTE();
      instr.i[OSC2_VOL] = bin.getUBYTE();
      instr.i[OSC2_WAVEFORM] = bin.getUBYTE();
    }
    else {
      instr.i[OSC2_WAVEFORM] = bin.getUBYTE();
      instr.i[OSC2_VOL] = bin.getUBYTE();
      instr.i[OSC2_SEMI] = bin.getUBYTE();
      instr.i[OSC2_DETUNE] = bin.getUBYTE();
      instr.i[OSC2_XENV] = version < 13 ? 64 * bin.getUBYTE() : bin.getUBYTE();
    }

    // Noise oscillator
    instr.i[NOISE_VOL] = bin.getUBYTE();

    // Envelope
    if (version < 5) {
      instr.i[ENV_ATTACK] = Math.round(Math.sqrt(bin.getULONG()) / 2);
      instr.i[ENV_SUSTAIN] = Math.round(Math.sqrt(bin.getULONG()) / 2);
      instr.i[ENV_RELEASE] = Math.round(Math.sqrt(bin.getULONG()) / 2);
    }
    else {
      instr.i[ENV_ATTACK] = bin.getUBYTE();
      instr.i[ENV_SUSTAIN] = bin.getUBYTE();
      instr.i[ENV_RELEASE] = bin.getUBYTE();
    }
    instr.i[ENV_EXP_DECAY] = version < 14 ? 0 : bin.getUBYTE();

    // Arpeggio
    if (version < 11) {
      instr.i[ARP_CHORD] = 0;
      instr.i[ARP_SPEED] = 0;
    }
    else {
      instr.i[ARP_CHORD] = bin.getUBYTE();
      instr.i[ARP_SPEED] = bin.getUBYTE();
    }

    if (version < 6) {
      // Effects
      instr.i[FX_FILTER] = bin.getUBYTE();
      if (version < 5)
        instr.i[FX_FREQ] = Math.round(bin.getUSHORT() / 43.23529);
      else
        instr.i[FX_FREQ] = bin.getUBYTE();
      instr.i[FX_RESONANCE] = bin.getUBYTE();

      instr.i[FX_DELAY_TIME] = bin.getUBYTE();
      instr.i[FX_DELAY_AMT] = bin.getUBYTE();
      instr.i[FX_PAN_FREQ] = bin.getUBYTE();
      instr.i[FX_PAN_AMT] = bin.getUBYTE();
      instr.i[FX_DIST] = bin.getUBYTE();
      instr.i[FX_DRIVE] = bin.getUBYTE();

      // LFO
      instr.i[LFO_FX_FREQ] = bin.getUBYTE();
      instr.i[LFO_FREQ] = bin.getUBYTE();
      instr.i[LFO_AMT] = bin.getUBYTE();
      instr.i[LFO_WAVEFORM] = bin.getUBYTE();
    }
    else {
      // LFO
      instr.i[LFO_WAVEFORM] = bin.getUBYTE();
      instr.i[LFO_AMT] = bin.getUBYTE();
      instr.i[LFO_FREQ] = bin.getUBYTE();
      instr.i[LFO_FX_FREQ] = bin.getUBYTE();

      // Effects
      instr.i[FX_FILTER] = bin.getUBYTE();
      instr.i[FX_FREQ] = bin.getUBYTE();
      instr.i[FX_RESONANCE] = bin.getUBYTE();
      instr.i[FX_DIST] = bin.getUBYTE();
      instr.i[FX_DRIVE] = bin.getUBYTE();
      instr.i[FX_PAN_AMT] = bin.getUBYTE();
      instr.i[FX_PAN_FREQ] = bin.getUBYTE();
      instr.i[FX_DELAY_AMT] = bin.getUBYTE();
      instr.i[FX_DELAY_TIME] = bin.getUBYTE();
    }

    // Patterns
    var song_rows;
    if (version < 9)
      song_rows = 48;
    else if (version < 12)
      song_rows = 128;
    else
      song_rows = song.endPattern + 1;
    instr.p = [];
    for (j = 0; j < song_rows; j++)
      instr.p[j] = bin.getUBYTE();
    for (j = song_rows; j < MAX_SONG_ROWS; j++)
      instr.p[j] = 0;

    // Columns
    var num_patterns = version < 9 ? 10 : MAX_PATTERNS;
    instr.c = [];
    for (j = 0; j < num_patterns; j++) {
      col = {};
      col.n = [];
      if (version == 1) {
        for (k = 0; k < song.patternLen; k++) {
          col.n[k] = bin.getUBYTE();
          col.n[k+song.patternLen] = 0;
          col.n[k+2*song.patternLen] = 0;
          col.n[k+3*song.patternLen] = 0;
        }
      }
      else {
        for (k = 0; k < song.patternLen * 4; k++)
          col.n[k] = bin.getUBYTE();
      }
      col.f = [];
      if (version < 4) {
        for (k = 0; k < song.patternLen * 2; k++)
          col.f[k] = 0;
      }
      else {
        for (k = 0; k < song.patternLen; k++) {
          var fxCmd = bin.getUBYTE();
          // We inserted two new commands in version 11
          if (version < 11 && fxCmd >= 14)
            fxCmd += 2;
          // We inserted ENV_EXP_DECAY in version 14
          if (version < 14 && fxCmd >= 14)
            fxCmd += 1;
          col.f[k] = fxCmd;
        }
        for (k = 0; k < song.patternLen; k++)
          col.f[song.patternLen + k] = bin.getUBYTE();
      }
      instr.c[j] = col;
    }
    for (j = num_patterns; j < MAX_PATTERNS; j++) {
      col = {};
      col.n = [];
      for (k = 0; k < song.patternLen * 4; k++)
        col.n[k] = 0;
      col.f = [];
      for (k = 0; k < song.patternLen * 2; k++)
        col.f[k] = 0;
      instr.c[j] = col;
    }

    // Fixup conversions
    if (version < 3) {
      if (instr.i[OSC1_WAVEFORM] == 2)
        instr.i[OSC1_VOL] = Math.round(instr.i[OSC1_VOL]/2);
      if (instr.i[OSC2_WAVEFORM] == 2)
        instr.i[OSC2_VOL] = Math.round(instr.i[OSC2_VOL]/2);
      if (instr.i[LFO_WAVEFORM] == 2)
        instr.i[LFO_AMT] = Math.round(instr.i[LFO_AMT]/2);
      instr.i[FX_DRIVE] = instr.i[FX_DRIVE] < 224 ? instr.i[FX_DRIVE] + 32 : 255;
    }
    if (version < 7)
      instr.i[FX_RESONANCE] = 255 - instr.i[FX_RESONANCE];

    song.songData[i] = instr;
  }
  for (; i < MAX_CHANNELS; i++) {
    song.songData[i] = makeEmptyChannel(song.patternLen);
  }

  return song;
};

export const sonantBinToSong = function (d) {
  // Check if this is a sonant song (correct length & reasonable end pattern)
  if (d.length != 3333)
    return undefined;
  if ((d.charCodeAt(3332) & 255) > 48)
    return undefined;

  var bin = new CBinParser(d);
  var song = {};

  // Row length
  song.rowLen = bin.getULONG();

  // Number of rows per pattern
  song.patternLen = 32;

  // All 8 instruments
  song.songData = [];
  var i, j, k, instr, col, master;
  for (i = 0; i < 8; i++) {
    instr = {};
    instr.i = [];

    // Oscillator 1
    instr.i[OSC1_SEMI] = 12 * (bin.getUBYTE() - 8) + 128;
    instr.i[OSC1_SEMI] += bin.getUBYTE();
    bin.getUBYTE(); // Skip (detune)
    instr.i[OSC1_XENV] = 64 * bin.getUBYTE();
    instr.i[OSC1_VOL] = bin.getUBYTE();
    instr.i[OSC1_WAVEFORM] = bin.getUBYTE();

    // Oscillator 2
    instr.i[OSC2_SEMI] = 12 * (bin.getUBYTE() - 8) + 128;
    instr.i[OSC2_SEMI] += bin.getUBYTE();
    instr.i[OSC2_DETUNE] = bin.getUBYTE();
    instr.i[OSC2_XENV] = 64 * bin.getUBYTE();
    instr.i[OSC2_VOL] = bin.getUBYTE();
    instr.i[OSC2_WAVEFORM] = bin.getUBYTE();

    // Noise oscillator
    instr.i[NOISE_VOL] = bin.getUBYTE();
    bin.getUBYTE(); // Pad!
    bin.getUBYTE(); // Pad!
    bin.getUBYTE(); // Pad!

    // Envelope
    instr.i[ENV_ATTACK] = Math.round(Math.sqrt(bin.getULONG()) / 2);
    instr.i[ENV_SUSTAIN] = Math.round(Math.sqrt(bin.getULONG()) / 2);
    instr.i[ENV_RELEASE] = Math.round(Math.sqrt(bin.getULONG()) / 2);
    master = bin.getUBYTE(); // env_master
    instr.i[ENV_EXP_DECAY] = 0;

    // Effects
    instr.i[FX_FILTER] = bin.getUBYTE();
    bin.getUBYTE(); // Pad!
    bin.getUBYTE(); // Pad!
    instr.i[FX_FREQ] = Math.round(bin.getFLOAT() / 43.23529);
    instr.i[FX_RESONANCE] = 255 - bin.getUBYTE();
    instr.i[FX_DELAY_TIME] = bin.getUBYTE();
    instr.i[FX_DELAY_AMT] = bin.getUBYTE();
    instr.i[FX_PAN_FREQ] = bin.getUBYTE();
    instr.i[FX_PAN_AMT] = bin.getUBYTE();
    instr.i[FX_DIST] = 0;
    instr.i[FX_DRIVE] = 32;

    // Arpeggio
    instr.i[ARP_CHORD] = 0;
    instr.i[ARP_SPEED] = 0;

    // LFO
    bin.getUBYTE(); // Skip! (lfo_osc1_freq)
    instr.i[LFO_FX_FREQ] = bin.getUBYTE();
    instr.i[LFO_FREQ] = bin.getUBYTE();
    instr.i[LFO_AMT] = bin.getUBYTE();
    instr.i[LFO_WAVEFORM] = bin.getUBYTE();

    // Patterns
    instr.p = [];
    for (j = 0; j < 48; j++)
      instr.p[j] = bin.getUBYTE();
    for (j = 48; j < MAX_SONG_ROWS; j++)
      instr.p[j] = 0;

    // Columns
    instr.c = [];
    for (j = 0; j < 10; j++) {
      col = {};
      col.n = [];
      for (k = 0; k < 32; k++) {
        col.n[k] = bin.getUBYTE();
        col.n[k+32] = 0;
        col.n[k+64] = 0;
        col.n[k+96] = 0;
      }
      col.f = [];
      for (k = 0; k < 32 * 2; k++)
        col.f[k] = 0;
      instr.c[j] = col;
    }
    for (j = 10; j < MAX_PATTERNS; j++) {
      col = {};
      col.n = [];
      for (k = 0; k < 32 * 4; k++)
        col.n[k] = 0;
      col.f = [];
      for (k = 0; k < 32 * 2; k++)
        col.f[k] = 0;
      instr.c[j] = col;
    }

    bin.getUBYTE(); // Pad!
    bin.getUBYTE(); // Pad!

    // Fixup conversions
    if (instr.i[FX_FILTER] < 1 || instr.i[FX_FILTER] > 3) {
      instr.i[FX_FILTER] = 2;
      instr.i[FX_FREQ] = 255; // 11025;
    }
    instr.i[OSC1_VOL] *= master / 255;
    instr.i[OSC2_VOL] *= master / 255;
    instr.i[NOISE_VOL] *= master / 255;
    if (instr.i[OSC1_WAVEFORM] == 2)
      instr.i[OSC1_VOL] /= 2;
    if (instr.i[OSC2_WAVEFORM] == 2)
      instr.i[OSC2_VOL] /= 2;
    if (instr.i[LFO_WAVEFORM] == 2)
      instr.i[LFO_AMT] /= 2;
    instr.i[OSC1_VOL] = Math.round(instr.i[OSC1_VOL]);
    instr.i[OSC2_VOL] = Math.round(instr.i[OSC2_VOL]);
    instr.i[NOISE_VOL] = Math.round(instr.i[NOISE_VOL]);
    instr.i[LFO_AMT] = Math.round(instr.i[LFO_AMT]);

    song.songData[i] = instr;
  }
  for (; i < MAX_CHANNELS; i++) {
    song.songData[i] = makeEmptyChannel(song.patternLen);
  }

  // Last pattern to play
  song.endPattern = bin.getUBYTE() + 2;

  return song;
};

export const instrumentToBin = function (instrI) {
  var bin = new CBinWriter();

  putInstrument(bin,instrI);

  // The code and file format are ready to support compressed data;
  // However, at the moment, the instruments are so small that no point
  // compressing. Replace this line with compress(bin.getData()) if needed
  var compressedData = {method:0,data:bin.getData()};

  // Create a new binary stream - this is the actual file
  bin = new CBinWriter();

  // Signature
  bin.putULONG(makeFourCC("SBxI"));

  // Format version
  bin.putUBYTE(3);

  // Compression method
  bin.putUBYTE(compressedData.method);

  // Append packed data
  bin.append(compressedData.data);

  return bin.getData();
};

export const binToInstrument = function (d) {
  var bin = new CBinParser(d);
  var instrI = [];

  // Signature
  var signature = bin.getULONG();

  // Format version
  var version = bin.getUBYTE();

  // Check if this is a SoundBox instrument
  if (signature != makeFourCC("SBxI") || (version < 1 || version > 3))
    return undefined;

  var compressionMethod = bin.getUBYTE();

  // Unpack instrument data
  var packedData = bin.getTail();
  var unpackedData = uncompress(compressionMethod,packedData);

  bin = new CBinParser(unpackedData);

  // Oscillator 1
  instrI[OSC1_WAVEFORM] = bin.getUBYTE();
  instrI[OSC1_VOL] = bin.getUBYTE();
  instrI[OSC1_SEMI] = bin.getUBYTE();
  // Version 1 only had two binary values for the OSC1_XENV
  instrI[OSC1_XENV] = version < 2 ? 64 * bin.getUBYTE() : bin.getUBYTE();

  // Oscillator 2
  instrI[OSC2_WAVEFORM] = bin.getUBYTE();
  instrI[OSC2_VOL] = bin.getUBYTE();
  instrI[OSC2_SEMI] = bin.getUBYTE();
  instrI[OSC2_DETUNE] = bin.getUBYTE();
  // Version 1 only had two binary values for the OSC2_XENV
  instrI[OSC2_XENV] = version < 2 ? 64 * bin.getUBYTE() : bin.getUBYTE();

  // Noise oscillator
  instrI[NOISE_VOL] = bin.getUBYTE();

  // Envelope
  instrI[ENV_ATTACK] = bin.getUBYTE();
  instrI[ENV_SUSTAIN] = bin.getUBYTE();
  instrI[ENV_RELEASE] = bin.getUBYTE();
  instrI[ENV_EXP_DECAY] = version < 3 ? 0 : bin.getUBYTE();

  // Arpeggio
  instrI[ARP_CHORD] = bin.getUBYTE();
  instrI[ARP_SPEED] = bin.getUBYTE();

  // LFO
  instrI[LFO_WAVEFORM] = bin.getUBYTE();
  instrI[LFO_AMT] = bin.getUBYTE();
  instrI[LFO_FREQ] = bin.getUBYTE();
  instrI[LFO_FX_FREQ] = bin.getUBYTE();

  // Effects
  instrI[FX_FILTER] = bin.getUBYTE();
  instrI[FX_FREQ] = bin.getUBYTE();
  instrI[FX_RESONANCE] = bin.getUBYTE();
  instrI[FX_DIST] = bin.getUBYTE();
  instrI[FX_DRIVE] = bin.getUBYTE();
  instrI[FX_PAN_AMT] = bin.getUBYTE();
  instrI[FX_PAN_FREQ] = bin.getUBYTE();
  instrI[FX_DELAY_AMT] = bin.getUBYTE();
  instrI[FX_DELAY_TIME] = bin.getUBYTE();

  return instrI;
};

export const binToSong = function (d) {
  // Try to parse the binary data as a SoundBox song
  var song = soundboxBinToSong(d);

  // Try to parse the binary data as a Sonant song
  if (!song)
    song = sonantBinToSong(d);

  if (!song) {
    // We coulnd't parse the song
    return undefined;
  }

  return song;
};

// Stage E.14: the song as a URL-safe string, for the Share link (see main.js).
// Same base64url encoding gui.js's makeURLSongData/getURLSongData used -- '+'
// and '/' swapped for '-'/'_' and the padding dropped, so the whole payload
// survives being pasted into a chat client untouched. The compressed binary
// format is what goes in rather than the JS export: it's several times shorter,
// and this direction never needs to be human-readable.
export const songToURLData = function (song) {
  return btoa(songToBin(song)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// The inverse. Throws on a payload that isn't valid base64 (atob's own error)
// and returns undefined on one that decodes but isn't a song -- callers treat
// both as "bad link".
export const urlDataToSong = function (str) {
  return binToSong(atob(str.replace(/-/g, '+').replace(/_/g, '/')));
};

export const songToJS = function (song) {
  var i, j, k;
  var jsData = "";

  jsData += "// This music has been exported by SoundBox. You can use it with\n";
  jsData += "// http://sb.bitsnbites.eu/player-small.js in your own product.\n\n";

  jsData += "// See http://sb.bitsnbites.eu/demo.html for an example of how to\n";
  jsData += "// use it in a demo.\n\n";

  jsData += "// Song data\n";
  jsData += "export default {\n";

  jsData += "      songData: [\n";
  for (i = 0; i < song.numChannels; i++) {
    var instr = song.songData[i];
    jsData += "        { // Instrument " + i + "\n";
    jsData += "          i: [\n";
    jsData += "          " + instr.i[OSC1_WAVEFORM] + ", // OSC1_WAVEFORM\n";
    jsData += "          " + instr.i[OSC1_VOL] + ", // OSC1_VOL\n";
    jsData += "          " + instr.i[OSC1_SEMI] + ", // OSC1_SEMI\n";
    jsData += "          " + instr.i[OSC1_XENV] + ", // OSC1_XENV\n";
    jsData += "          " + instr.i[OSC2_WAVEFORM] + ", // OSC2_WAVEFORM\n";
    jsData += "          " + instr.i[OSC2_VOL] + ", // OSC2_VOL\n";
    jsData += "          " + instr.i[OSC2_SEMI] + ", // OSC2_SEMI\n";
    jsData += "          " + instr.i[OSC2_DETUNE] + ", // OSC2_DETUNE\n";
    jsData += "          " + instr.i[OSC2_XENV] + ", // OSC2_XENV\n";
    jsData += "          " + instr.i[NOISE_VOL] + ", // NOISE_VOL\n";
    jsData += "          " + instr.i[ENV_ATTACK] + ", // ENV_ATTACK\n";
    jsData += "          " + instr.i[ENV_SUSTAIN] + ", // ENV_SUSTAIN\n";
    jsData += "          " + instr.i[ENV_RELEASE] + ", // ENV_RELEASE\n";
    jsData += "          " + instr.i[ENV_EXP_DECAY] + ", // ENV_EXP_DECAY\n";
    jsData += "          " + instr.i[ARP_CHORD] + ", // ARP_CHORD\n";
    jsData += "          " + instr.i[ARP_SPEED] + ", // ARP_SPEED\n";
    jsData += "          " + instr.i[LFO_WAVEFORM] + ", // LFO_WAVEFORM\n";
    jsData += "          " + instr.i[LFO_AMT] + ", // LFO_AMT\n";
    jsData += "          " + instr.i[LFO_FREQ] + ", // LFO_FREQ\n";
    jsData += "          " + instr.i[LFO_FX_FREQ] + ", // LFO_FX_FREQ\n";
    jsData += "          " + instr.i[FX_FILTER] + ", // FX_FILTER\n";
    jsData += "          " + instr.i[FX_FREQ] + ", // FX_FREQ\n";
    jsData += "          " + instr.i[FX_RESONANCE] + ", // FX_RESONANCE\n";
    jsData += "          " + instr.i[FX_DIST] + ", // FX_DIST\n";
    jsData += "          " + instr.i[FX_DRIVE] + ", // FX_DRIVE\n";
    jsData += "          " + instr.i[FX_PAN_AMT] + ", // FX_PAN_AMT\n";
    jsData += "          " + instr.i[FX_PAN_FREQ] + ", // FX_PAN_FREQ\n";
    jsData += "          " + instr.i[FX_DELAY_AMT] + ", // FX_DELAY_AMT\n";
    jsData += "          " + instr.i[FX_DELAY_TIME] + " // FX_DELAY_TIME\n";
    jsData += "          ],\n";

    // Sequencer data for this instrument
    jsData += "          // Patterns\n";
    jsData += "          p: [";
    var lastRow = song.endPattern;
    var maxPattern = 0, lastNonZero = 0;
    for (j = 0; j <= lastRow; j++) {
      var pattern = instr.p[j];
      if (pattern > maxPattern)
        maxPattern = pattern;
      if (pattern)
        lastNonZero = j;
    }
    for (j = 0; j <= lastNonZero; j++) {
      var pattern = instr.p[j];
      if (pattern)
        jsData += pattern;
      if (j < lastNonZero)
        jsData += ",";
    }
    jsData += "],\n";

    // Pattern data for this instrument
    jsData += "          // Columns\n";
    jsData += "          c: [\n";
    for (j = 0; j < maxPattern; j++) {
      jsData += "            {n: [";
      lastNonZero = 0;
      for (k = 0; k < song.patternLen * 4; k++) {
        if (instr.c[j].n[k])
          lastNonZero = k;
      }
      for (k = 0; k <= lastNonZero; k++) {
        var note = instr.c[j].n[k];
        if (note)
          jsData += note;
        if (k < lastNonZero)
          jsData += ",";
      }
      jsData += "],\n";
      jsData += "             f: [";
      lastNonZero = 0;
      for (k = 0; k < song.patternLen * 2; k++) {
        if (instr.c[j].f[k])
          lastNonZero = k;
      }
      for (k = 0; k <= lastNonZero; k++) {
        var fx = instr.c[j].f[k];
        if (fx)
          jsData += fx;
        if (k < lastNonZero)
          jsData += ",";
      }
      jsData += "]}";
      if (j < maxPattern - 1)
        jsData += ",";
      jsData += "\n";
    }
    jsData += "          ]\n";
    jsData += "        }";
    if (i < song.numChannels)
      jsData += ",";
    jsData += "\n";
  }

  jsData += "      ],\n";
  jsData += "      rowLen: " + song.rowLen + ",   // In sample lengths\n";
  jsData += "      patternLen: " + song.patternLen + ",  // Rows per pattern\n";
  jsData += "      endPattern: " + song.endPattern + ",  // End pattern\n";
  jsData += "      numChannels: " + song.numChannels + "  // Number of channels\n";
  jsData += "};\n";

  return jsData;
};

//------------------------------------------------------------------------------
// JS import (plans/soundbox-revamp.md Phase 4) -- the inverse of songToJS().
//
// The exported literal is (modulo the `export default` wrapper) the internal
// song object, but *trimmed*: trailing zero notes/fx/sequencer rows are cut,
// unused patterns and channels are dropped entirely, and skipped values are
// written as array holes (`[1,,2]`). So importing is two steps -- actually
// evaluate the module (rather than hand-rolling a parser that would have to
// track every future change to songToJS), then re-inflate the result back to
// the dense, fixed-size shape makeNewSong()/binToSong() produce and the rest
// of the editor assumes (every channel present, p[] MAX_SONG_ROWS long, c[]
// MAX_PATTERNS long, n[]/f[] patternLen*4 / patternLen*2 long).
//
// Evaluating the module means an imported file runs as code. That's the same
// trust level as every other .js this repo's toolchain loads, but it's the
// user's own machine, so the UI says so next to the import control.
//------------------------------------------------------------------------------

// Fixed-size, hole-free copy of `src` into a zero-filled array of length
// `len` -- holes and anything non-numeric become 0.
var inflateArray = function (src, len) {
  var out = [], i, v;
  for (i = 0; i < len; i++) {
    v = Array.isArray(src) ? src[i] : undefined;
    out[i] = typeof v === 'number' && isFinite(v) ? v : 0;
  }
  return out;
};

var isInt = function (v, lo, hi) {
  return typeof v === 'number' && isFinite(v) && v === Math.round(v) && v >= lo && v <= hi;
};

// True for the *other* JS song format that turns up in this repo: the old
// sonant/sonant-x editor's export, whose channels carry named instrument
// properties (osc1_oct, env_attack, ...) instead of SoundBox's `i[]` array.
var looksLikeSonantX = function (raw) {
  var c = raw && raw.songData && raw.songData[0];
  return !!c && typeof c === 'object' && !Array.isArray(c.i) && typeof c.osc1_waveform === 'number';
};

// Converts a sonant-x song object into the (sparse) SoundBox shape
// normalizeSong() below then inflates. This is exactly sonantBinToSong()'s
// per-instrument conversion, minus the byte parsing -- same semitone packing,
// same sqrt envelope scale, same 43.23529 Hz-per-unit filter frequency, same
// inverted resonance, same master-volume/waveform fixups -- because both
// formats are two encodings of the same synth. Sonant has no distortion,
// drive, arpeggio, exponential decay or LFO-on-osc1, so those get SoundBox's
// neutral defaults, and its single note column per row maps to SoundBox's
// first of four (the trailing three inflate to zeros).
export const sonantXToSong = function (raw) {
  var song = {
    rowLen: raw.rowLen,
    patternLen: isInt(raw.patternLen, 1, 256) ? raw.patternLen : 32,
    // Sonant's own endPattern field counts rows differently across versions
    // (its binary loader has to add 2 to the stored byte), so it's derived
    // from the sequencer data below instead -- that plays every row that has
    // a pattern in it, and nothing more.
    endPattern: 0,
    numChannels: Math.min(raw.songData.length, MAX_CHANNELS),
    songData: []
  };

  var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };

  for (var ch = 0; ch < song.numChannels; ch++) {
    var src = raw.songData[ch] || {};
    var i = [];

    i[OSC1_WAVEFORM] = num(src.osc1_waveform);
    i[OSC1_VOL] = num(src.osc1_vol);
    i[OSC1_SEMI] = 12 * (num(src.osc1_oct) - 8) + 128 + num(src.osc1_det);
    i[OSC1_XENV] = 64 * num(src.osc1_xenv);

    i[OSC2_WAVEFORM] = num(src.osc2_waveform);
    i[OSC2_VOL] = num(src.osc2_vol);
    i[OSC2_SEMI] = 12 * (num(src.osc2_oct) - 8) + 128 + num(src.osc2_det);
    i[OSC2_DETUNE] = num(src.osc2_detune);
    i[OSC2_XENV] = 64 * num(src.osc2_xenv);

    i[NOISE_VOL] = num(src.noise_fader);

    // Sonant stores envelope times as raw sample counts; SoundBox squares
    // (2*value) to get them back.
    i[ENV_ATTACK] = Math.round(Math.sqrt(num(src.env_attack)) / 2);
    i[ENV_SUSTAIN] = Math.round(Math.sqrt(num(src.env_sustain)) / 2);
    i[ENV_RELEASE] = Math.round(Math.sqrt(num(src.env_release)) / 2);
    i[ENV_EXP_DECAY] = 0;

    i[ARP_CHORD] = 0;
    i[ARP_SPEED] = 0;

    // src.lfo_osc1_freq has no SoundBox equivalent and is dropped.
    i[LFO_WAVEFORM] = num(src.lfo_waveform);
    i[LFO_AMT] = num(src.lfo_amt);
    i[LFO_FREQ] = num(src.lfo_freq);
    i[LFO_FX_FREQ] = num(src.lfo_fx_freq);

    i[FX_FILTER] = num(src.fx_filter);
    i[FX_FREQ] = Math.min(255, Math.round(num(src.fx_freq) / 43.23529));
    i[FX_RESONANCE] = 255 - num(src.fx_resonance);
    i[FX_DIST] = 0;
    i[FX_DRIVE] = 32;
    i[FX_PAN_AMT] = num(src.fx_pan_amt);
    i[FX_PAN_FREQ] = num(src.fx_pan_freq);
    i[FX_DELAY_AMT] = num(src.fx_delay_amt);
    i[FX_DELAY_TIME] = num(src.fx_delay_time);

    // Fixup conversions (identical to sonantBinToSong's)
    var master = num(src.env_master);
    if (i[FX_FILTER] < 1 || i[FX_FILTER] > 3) {
      i[FX_FILTER] = 2;
      i[FX_FREQ] = 255; // 11025 Hz, i.e. effectively open
    }
    i[OSC1_VOL] *= master / 255;
    i[OSC2_VOL] *= master / 255;
    i[NOISE_VOL] *= master / 255;
    if (i[OSC1_WAVEFORM] == 2) i[OSC1_VOL] /= 2;
    if (i[OSC2_WAVEFORM] == 2) i[OSC2_VOL] /= 2;
    if (i[LFO_WAVEFORM] == 2) i[LFO_AMT] /= 2;
    i[OSC1_VOL] = Math.round(i[OSC1_VOL]);
    i[OSC2_VOL] = Math.round(i[OSC2_VOL]);
    i[NOISE_VOL] = Math.round(i[NOISE_VOL]);
    i[LFO_AMT] = Math.round(i[LFO_AMT]);

    var p = Array.isArray(src.p) ? src.p.slice(0, MAX_SONG_ROWS) : [];
    for (var r = 0; r < p.length; r++)
      if (num(p[r])) song.endPattern = Math.max(song.endPattern, r);

    var c = [];
    if (Array.isArray(src.c)) {
      for (var j = 0; j < Math.min(src.c.length, MAX_PATTERNS); j++)
        c[j] = { n: (src.c[j] && src.c[j].n) || [], f: (src.c[j] && src.c[j].f) || [] };
    }

    song.songData[ch] = { i: i, p: p, c: c };
  }

  return song;
};

// Validates a raw object parsed out of an exported module and re-inflates it
// into a full song. Returns undefined if it doesn't look like a song at all.
export const normalizeSong = function (raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.songData) || !raw.songData.length)
    return undefined;
  if (looksLikeSonantX(raw))
    raw = sonantXToSong(raw);
  if (!isInt(raw.numChannels, 1, MAX_CHANNELS) ||
      !isInt(raw.patternLen, 1, 256) ||
      !isInt(raw.endPattern, 0, MAX_SONG_ROWS - 1) ||
      !(typeof raw.rowLen === 'number' && isFinite(raw.rowLen) && raw.rowLen > 0))
    return undefined;

  var song = {
    rowLen: raw.rowLen,
    patternLen: raw.patternLen,
    endPattern: raw.endPattern,
    numChannels: raw.numChannels,
    songData: []
  };

  for (var i = 0; i < MAX_CHANNELS; i++) {
    // Channels the export left out (everything past numChannels, and any
    // hole in between) come back as fresh default-instrument channels.
    var chan = makeEmptyChannel(song.patternLen);
    var src = raw.songData[i];
    // makeEmptyChannel's instrument copy loop is `j <= length`, so a fresh
    // channel's i[] carries one trailing undefined past the real parameters;
    // running it through inflateArray too keeps every channel exactly
    // NUM_INSTR_PARAMS long whether it came from the file or not.
    var instrI = src && Array.isArray(src.i) ? src.i : chan.i;
    var legacyInstr = instrI.length === NUM_INSTR_PARAMS - 1;
    // SoundBox builds predating the exponential-decay envelope wrote
    // 28-parameter instruments, where everything from ARP_CHORD on sits one
    // slot low -- padding at the end (what inflateArray would do) would
    // silently reinterpret every one of them. Splicing a zero into
    // ENV_EXP_DECAY's place restores both the layout and the old behavior:
    // the release curve is `(1 - e) * 3 ** (-i[ENV_EXP_DECAY]/16 * e)`, which
    // at zero is exactly the linear release those builds had.
    if (legacyInstr)
      instrI = instrI.slice(0, ENV_EXP_DECAY).concat(0, instrI.slice(ENV_EXP_DECAY));
    chan.i = inflateArray(instrI, NUM_INSTR_PARAMS);
    if (src && typeof src === 'object') {
      chan.p = inflateArray(src.p, MAX_SONG_ROWS);
      if (Array.isArray(src.c)) {
        for (var j = 0; j < MAX_PATTERNS; j++) {
          var col = src.c[j];
          if (!col || typeof col !== 'object') continue;
          chan.c[j] = {
            n: inflateArray(col.n, song.patternLen * 4),
            f: inflateArray(col.f, song.patternLen * 2)
          };
          // An fx command is a parameter index plus one (the player runs
          // `instr.i[cmdNo - 1] = value`), so the pre-ENV_EXP_DECAY layout
          // shifts the automation lane too -- every command at or past the
          // inserted slot addresses the parameter below the one it names now.
          if (legacyInstr)
            for (var k = 0; k < song.patternLen; k++)
              if (chan.c[j].f[k] > ENV_EXP_DECAY) chan.c[j].f[k]++;
        }
      }
    }
    song.songData[i] = chan;
  }

  return song;
};

// Loads the text of an exported .js song. Async because it evaluates the
// text as a real ES module (blob URL + dynamic import) -- see the section
// comment above. Resolves to a song, or to undefined for anything that
// doesn't parse/evaluate/validate, so callers can show the same "format not
// recognized" message binToSong's failure path uses.
export const songFromJS = function (text) {
  // Older SoundBox builds exported `export default name = {...}`, which
  // assigns to an undeclared identifier -- a ReferenceError in a module (they
  // are always strict), so such a file won't even evaluate until the stray
  // name is dropped. Nothing ever read it.
  text = text.replace(/(export\s+default\s+)[A-Za-z_$][\w$]*\s*=\s*(?=[{[])/, '$1');
  var url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  return import(url).then(
    function (mod) { return normalizeSong(mod.default); },
    function () { return undefined; }
  ).then(function (song) {
    URL.revokeObjectURL(url);
    return song;
  });
};
