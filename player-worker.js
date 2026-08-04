/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Voxby v2 render worker.
*
* Derived from SoundBox by Marcus Geelnard (c) 2011-2013. The oscillators and
* the effects chain are still his; the sequencing, the envelope and the song
* format are not. Distributed under the GNU General Public License, version 3
* or later -- see gpl.txt.
*
* This is the offline renderer the editor's Play and Export WAV go through. It
* is the same algorithm as src/js/core/voxby.js, the player a game ships, with
* one thing added: a render window. The editor has to be able to render one
* sequence row of three channels for Space, and voxby.js always renders the
* whole song.
*
* Keeping the two in step matters. If they disagree, the editor lies about what
* the game will play. See plans/voxby-synth-v2.md.
*/

"use strict";

var CPlayerWorker = function () {

  //----------------------------------------------------------------------------
  // Effect commands. Must match src/js/core/voxby.js and engine2.js.
  //----------------------------------------------------------------------------
  var SLIDE_TO = 1, SLIDE = 2, VIBRATO = 3, TEMPO = 4,
      NOTE_DELAY = 5, GATE = 6, PARAM = 32;
  var NOTE_OFF = 1;

  // Pitch rates are given in sixteenths of a semitone per row, so 16 is one
  // semitone per row. Vibrato speed is in sixteenths of a cycle per row.
  var SIXTEENTH = 1 / 16;

  //----------------------------------------------------------------------------
  // Oscillators. Unchanged from SoundBox.
  //----------------------------------------------------------------------------
  var osc_sin = function (value) { return Math.sin(value * 6.283184); };
  var osc_saw = function (value) { return 2 * (value % 1) - 1; };
  var osc_square = function (value) { return (value % 1) < 0.5 ? 1 : -1; };
  var osc_tri = function (value) {
    var v2 = (value % 1) * 4;
    if (v2 < 2) return v2 - 1;
    return 3 - v2;
  };
  var mOscillators = [osc_sin, osc_square, osc_saw, osc_tri];

  var getnotefreq = function (n) {
    // 174.61.. / 44100 = 0.003959503758 (F3)
    return 0.003959503758 * Math.pow(2, (n - 128) / 12);
  };

  // SoundBox's envelope curve: 1 at t = 0, 0 at t = 1. `k` bends it -- 0 is a
  // straight line, negative values fall away steeply and then flatten out.
  // Used for both the decay and the release, so the two share a character.
  var curve = function (t, k) {
    return (1 - t) * Math.pow(3, k * t);
  };

  //----------------------------------------------------------------------------
  // Voices
  //----------------------------------------------------------------------------

  // Start a voice, snapshotting the instrument as it stands now. A later change
  // to that instrument does not reach a note already sounding, which is what
  // makes per-row instrument changes safe.
  //
  // Velocity folds into the oscillator volumes rather than costing a multiply
  // on every sample.
  var startVoice = function (i, n, vel, rowLen) {
    var g = vel / 127;
    return {
      pitch: n,
      osc1: mOscillators[i[0]],
      o1vol: i[1] * g,
      o1semi: i[2],
      o1xenv: i[3] / 32,
      osc2: mOscillators[i[4]],
      o2vol: i[5] * g,
      o2semi: i[6],
      o2detune: 1 + 0.0008 * i[7],
      o2xenv: i[8] / 32,
      noiseVol: i[9] * g,

      // ADSR. Times are in samples, the level is 0..1.
      attack: i[10] * i[10] * 4,
      decay: i[11] * i[11] * 4,
      sustain: i[12] / 255,
      release: i[13] * i[13] * 4,
      expDecay: -i[14] / 16,

      arp: i[15],
      arpInterval: rowLen * Math.pow(2, 2 - i[16]),

      gate: 1,
      relAt: 0,
      relLevel: 0,
      gateRows: 0,
      gateAt: -1,

      slide: 0,
      target: null,
      vibDepth: 0,
      vibRate: 0,
      vibPhase: 0,

      j: 0, j2: 0, c1: 0, c2: 0, o1t: 0, o2t: 0,
    };
  };

  // The envelope level while the gate is open.
  var openLevel = function (v) {
    if (v.j < v.attack) return v.j / v.attack;
    if (v.j < v.attack + v.decay) {
      return v.sustain + (1 - v.sustain) * curve((v.j - v.attack) / v.decay, v.expDecay);
    }
    return v.sustain;
  };

  // Close the gate. The release starts from wherever the envelope had got to,
  // so releasing during the attack does not jump to full volume first.
  // Tolerates null: a note-off on a column that holds nothing is ordinary
  // tracker data rather than an error.
  var releaseVoice = function (v) {
    if (v && v.gate) {
      v.relLevel = openLevel(v);
      v.relAt = v.j;
      v.gate = 0;
    }
  };

  var isDead = function (v) {
    if (!v.gate) return v.j - v.relAt >= v.release;
    // Held, but decayed to nothing and unable to rise again.
    return v.sustain <= 0 && v.j >= v.attack + v.decay;
  };

  // One sample of one voice, as a truncated integer.
  var voiceSample = function (v) {
    // Recomputing the oscillator frequencies costs two exponentiations, so it
    // happens only when the pitch can actually have moved.
    var refresh = v.slide || v.vibDepth;

    if (v.j2 >= 0) {
      v.arp = (v.arp >> 8) | ((v.arp & 255) << 4);
      v.j2 -= v.arpInterval;
      refresh = 1;
    }

    if (v.slide) {
      v.pitch += v.slide;
      if (v.target !== null &&
          (v.slide > 0 ? v.pitch >= v.target : v.pitch <= v.target)) {
        v.pitch = v.target;
        v.slide = 0;
        v.target = null;
      }
    }

    if (refresh) {
      var p = v.pitch + (v.arp & 15);
      if (v.vibDepth) {
        v.vibPhase += v.vibRate;
        p += Math.sin(v.vibPhase * 6.283184) * v.vibDepth;
      }
      v.o1t = getnotefreq(p + v.o1semi - 128);
      v.o2t = getnotefreq(p + v.o2semi - 128) * v.o2detune;
    }

    var e = v.gate ? openLevel(v)
      : v.relLevel * curve((v.j - v.relAt) / v.release, v.expDecay);

    v.c1 += v.o1t * Math.pow(e, v.o1xenv);
    var rsample = v.osc1(v.c1) * v.o1vol;

    v.c2 += v.o2t * Math.pow(e, v.o2xenv);
    rsample += v.osc2(v.c2) * v.o2vol;

    if (v.noiseVol) {
      rsample += (2 * Math.random() - 1) * v.noiseVol;
    }

    v.j++;
    v.j2++;
    return (80 * rsample * e) | 0;
  };

  //----------------------------------------------------------------------------
  // Public methods
  //----------------------------------------------------------------------------

  // Find a TEMPO command on one global row, searching every channel. The
  // lowest channel index wins, then the lowest column. Returns -1 for none.
  //
  // Every channel, not just the rendered ones: a tempo change is global, so a
  // "play selected" of two channels must run at the speed the whole song would
  // have been running at there. Otherwise Space and Play disagree.
  var tempoAt = function (song, p, row) {
    for (var c = 0; c < song.numChannels; c++) {
      var ch = song.channels[c], cp = ch.seq[p];
      if (!cp) continue;
      var pat = ch.pat[cp - 1];
      if (!pat) continue;
      for (var col = 0; col < 4; col++) {
        var s = (row + col * song.patternLen) * 2;
        if (pat.e[s] === TEMPO) return pat.e[s + 1];
      }
    }
    return -1;
  };

  // Initialize buffers etc.
  this.init = function (song, opts) {
    this.firstRow = 0;
    this.lastRow = song.endPattern;
    this.firstCol = 0;
    this.lastCol = song.numChannels - 1;
    // Optional whitelist of channels within firstCol..lastCol. The column range
    // alone cannot describe "these channels, not that one in the middle", which
    // is what the sequencer's mute toggles ask for (see tracker.js's
    // getPlayRange). Absent, the whole span renders as before.
    this.cols = null;
    if (opts) {
      this.firstRow = opts.firstRow;
      this.lastRow = opts.lastRow;
      this.firstCol = opts.firstCol;
      this.lastCol = opts.lastCol;
      this.cols = opts.cols || null;
    }

    this.song = song;
    this.currentCol = this.firstCol;

    // TEMPO is global: it changes the speed of every channel, whichever channel
    // it was entered on. That cannot work per channel, because channels render
    // one at a time into a shared mix buffer and would drift apart. So one
    // pre-pass walks the rendered rows in global row order, reads the tempo
    // commands from every channel at once, and builds the row-to-sample table
    // that all of them then index.
    //
    // It also replaces the old length calculation: with a variable row length,
    // the buffer size can no longer be derived from song.rowLen.
    var patternLen = song.patternLen;
    var totalRows = patternLen * (this.lastRow - this.firstRow + 1);
    this.rowStart = new Int32Array(totalRows + 1);
    this.rowLen = new Int32Array(totalRows);

    // The tempo in force at the window's first row is whatever the song had
    // reached by then, so the scan starts at row 0 even when the render does
    // not. A pattern played on its own then sounds at the speed it does in the
    // song, rather than snapping back to the song's starting tempo.
    var len = song.rowLen, g, t;
    for (g = 0; g < this.firstRow * patternLen; g++) {
      t = tempoAt(song, (g / patternLen) | 0, g % patternLen);
      if (t > 0) len = t;
    }
    for (g = 0; g < totalRows; g++) {
      var abs = this.firstRow * patternLen + g;
      t = tempoAt(song, (abs / patternLen) | 0, abs % patternLen);
      if (t > 0) len = t;
      this.rowLen[g] = len;
      this.rowStart[g + 1] = this.rowStart[g] + len;
    }

    this.numSamples = this.rowStart[totalRows];
    this.numWords = this.numSamples * 2;
    this.mixBufWork = new Int32Array(this.numWords);
  };

  // Generate audio data for every channel in the window.
  this.generate = function () {
    var i, j, p, row, col, k, t, rsample, f;
    var song = this.song, patternLen = song.patternLen;
    var cols = this.cols;

    for (var currentCol = this.firstCol; currentCol <= this.lastCol; currentCol++) {
      // Muted channel: leave it out of the mix entirely. Skipping costs a
      // column's worth of progress messages, which is harmless -- onmessage
      // posts a final progress of 1 with the buffer once generate() returns.
      if (cols && cols.indexOf(currentCol) < 0) continue;

      var chnBuf = new Int32Array(this.numWords),
          mixBuf = this.mixBufWork,
          ch = song.channels[currentCol],
          fx = ch.fx.slice();   // a PARAM writes into this; the song must not change

      // Clear effect state
      var low = 0, band = 0, high;
      var lsample, filterActive = false;

      // Every voice still sounding on this channel, in start order. This
      // replaces the old player's note cache.
      //
      // It is a list rather than four fixed slots because a released voice has
      // to ring out while the next note in its column already sounds. `cur`
      // names the voice a column's note-off, gate or slide addresses.
      var voices = [];
      var cur = [null, null, null, null];
      // A velocity or instrument field of 0 means "unchanged", so each column
      // remembers what it last used.
      var lastVel = [127, 127, 127, 127];
      var lastIns = [ch.ins, ch.ins, ch.ins, ch.ins];

      for (p = this.firstRow; p <= this.lastRow; ++p) {
        var cp = ch.seq[p];
        var pat = cp ? ch.pat[cp - 1] : null;

        for (row = 0; row < patternLen; ++row) {
          var g = (p - this.firstRow) * patternLen + row;
          var rowLen = this.rowLen[g];

          // --- events on this row, per column ---------------------------
          for (col = 0; col < 4; ++col) {
            var s = row + col * patternLen;
            var cmd = pat ? pat.e[s * 2] : 0;
            var val = pat ? pat.e[s * 2 + 1] || 0 : 0;
            var nv = pat ? pat.n[s] : 0;
            var v = cur[col];

            if (nv === NOTE_OFF) {
              releaseVoice(v);
              cur[col] = v = null;
            } else if (nv && cmd === SLIDE_TO && v) {
              // A slide to a note bends the voice that is already sounding. It
              // must not re-trigger, so the note on this row is read as a
              // destination, not as a note-on.
              //
              // If the column holds nothing -- the previous note ended, or
              // there was none -- this falls through and the note simply plays.
              // That is what a tracker does with a tone portamento and no voice
              // to bend.
              v.target = nv & 255;
              if (val) v.slide = val * SIXTEENTH / rowLen;
              v.slide = Math.abs(v.slide) * (v.target < v.pitch ? -1 : 1);
            } else if (nv) {
              // A new note releases the column's previous voice. It rings out
              // through its own release rather than being cut. Without this, a
              // note that never receives a note-off would stack up forever.
              releaseVoice(v);

              var vel = (nv >> 8) & 127;
              var ins = nv >> 15;
              if (vel) lastVel[col] = vel;
              if (ins) lastIns[col] = ins - 1;

              var instr = song.instruments[lastIns[col]] || song.instruments[0];
              v = startVoice(instr, nv & 255, lastVel[col], rowLen);
              cur[col] = v;
              voices.push(v);
            }

            if (cmd >= PARAM) {
              fx[cmd - PARAM] = val;
            } else if (v) {
              if (cmd === GATE) {
                v.gateRows = val;
              } else if (cmd === SLIDE) {
                // A free bend: no destination, so it runs until it is changed
                // or the note ends. SLIDE 0 stops it.
                v.target = null;
                v.slide = val * SIXTEENTH / rowLen;
              } else if (cmd === VIBRATO) {
                // speed * 256 + depth, both in sixteenths.
                var depth = val & 255, speed = val >> 8;
                v.vibDepth = depth * SIXTEENTH;
                v.vibRate = speed * SIXTEENTH / rowLen;
              } else if (cmd === NOTE_DELAY) {
                // Run the voice backwards in time: it stays silent until j
                // reaches 0. Only meaningful on the row that started it.
                if (v.j === 0) v.j = -val;
              }
            }
          }

          // Effect parameters are re-read every row, so a PARAM write takes
          // effect on the row after the one that wrote it. Row length is read
          // here too, so a tempo change retunes the LFO, the panning and the
          // delay along with it.
          var oscLFO = mOscillators[fx[0]],
              lfoAmt = fx[1] / 512,
              lfoFreq = Math.pow(2, fx[2] - 9) / rowLen,
              fxLFO = fx[3],
              fxFilter = fx[4],
              fxFreq = fx[5] * 43.23529 * 3.141592 / 44100,
              q = 1 - fx[6] / 255,
              dist = fx[7] * 1e-5,
              drive = fx[8] / 32,
              panAmt = fx[9] / 512,
              panFreq = 6.283184 * Math.pow(2, fx[10] - 9) / rowLen,
              dlyAmt = fx[11] / 255,
              dly = fx[12] * rowLen & ~1;  // Must be an even number

          // Count this row off every running gate. The last row of a gate turns
          // into a sample deadline, so a fractional gate length releases
          // part-way through a row instead of being rounded up to the whole of
          // it. Using this row's length means a tempo change is honoured right
          // up to the release.
          for (i = 0; i < voices.length; i++) {
            var gv = voices[i];
            if (gv.gateRows > 0) {
              if (gv.gateRows >= 1) {
                if (!(gv.gateRows -= 1)) gv.gateAt = gv.j + rowLen;
              } else {
                gv.gateAt = gv.j + gv.gateRows * rowLen;
                gv.gateRows = 0;
              }
            }
          }

          var rowStartSample = this.rowStart[g];

          for (j = 0; j < rowLen; j++) {
            k = (rowStartSample + j) * 2;

            // Sum the live voices into the dry mono sample. Walking backwards
            // lets a finished voice splice itself out without disturbing the
            // indices still to come.
            var dry = 0;
            for (var vi = voices.length - 1; vi >= 0; vi--) {
              var vv = voices[vi];
              if (isDead(vv)) {
                voices.splice(vi, 1);
                for (var c = 0; c < 4; c++) if (cur[c] === vv) cur[c] = null;
              } else if (vv.j < 0) {
                vv.j++;      // held back by NOTE_DELAY
              } else {
                if (vv.gate && vv.gateAt >= 0 && vv.j >= vv.gateAt) releaseVoice(vv);
                dry += voiceSample(vv);
              }
            }
            // Written into chnBuf rather than used directly, because a delay
            // time of 0 makes the delay read this very sample back out again.
            chnBuf[k] = dry;
            rsample = chnBuf[k];

            // We only do effects if we have some sound input
            if (rsample || filterActive) {
              // State variable filter
              f = fxFreq;
              if (fxLFO) {
                f *= oscLFO(lfoFreq * k) * lfoAmt + 0.5;
              }
              f = 1.5 * Math.sin(f);
              low += f * band;
              high = q * (rsample - band) - low;
              band += f * high;
              rsample = fxFilter == 3 ? band : fxFilter == 1 ? high : low;

              // Distortion
              if (dist) {
                rsample *= dist;
                rsample = rsample < 1 ? rsample > -1 ? osc_sin(rsample * .25) : -1 : 1;
                rsample /= dist;
              }

              // Drive
              rsample *= drive;

              // Is the filter active (i.e. still audiable)?
              filterActive = rsample * rsample > 1e-5;

              // Panning
              t = Math.sin(panFreq * k) * panAmt + 0.5;
              lsample = rsample * (1 - t);
              rsample *= t;
            } else {
              lsample = 0;
            }

            // Delay is always done, since it does not need sound input
            if (k >= dly) {
              lsample += chnBuf[k - dly + 1] * dlyAmt;
              rsample += chnBuf[k - dly] * dlyAmt;
            }

            // Store in stereo channel buffer (needed for the delay effect)
            chnBuf[k] = lsample | 0;
            chnBuf[k + 1] = rsample | 0;

            // ...and add to stereo mix buffer
            mixBuf[k] += lsample | 0;
            mixBuf[k + 1] += rsample | 0;
          }
        }

        // Post progress to the main thread...
        var progress = (currentCol - this.firstCol + (p - this.firstRow) /
                        (this.lastRow - this.firstRow + 1)) /
                       (this.lastCol - this.firstCol + 1);
        postMessage({ cmd: "progress", progress: progress, buffer: null });
      }
    }
  };

  // Get the final buffer (as generated by the generate() method).
  this.getBuf = function () {
    return this.mixBufWork;
  };
};

var gPlayerWorker = new CPlayerWorker();

onmessage = function (event) {
  if (event.data.cmd === "generate") {
    gPlayerWorker.init(event.data.song, event.data.opts);
    gPlayerWorker.generate();

    // Signal that we are done, and send the resulting buffer over to the main
    // thread.
    postMessage({
      cmd: "progress",
      progress: 1,
      buffer: gPlayerWorker.getBuf()
    });
  }
};
