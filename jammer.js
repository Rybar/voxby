/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2017 Marcus Geelnard
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

"use strict";

var CJammer = function () {

  //--------------------------------------------------------------------------
  // Private members
  //--------------------------------------------------------------------------

  // Currently playing notes.
  var MAX_POLYPHONY = 8;
  var mPlayingNotes = [];

  // Current voice (17 numbers) and channel strip (13). v2 splits what used to
  // be one 28-number instrument: a voice is snapshotted per note, the strip is
  // read live by the effects chain.
  var mInstr;
  var mFx;

  // Current row length (i.e. BPM).
  var mRowLen;

  // Effect state.
  var mFXState;

  // Delay buffers.
  var MAX_DELAY = 131072;   // Must be a power of 2.
  var mDlyLeft, mDlyRight;
  var mRequestClearFilter = false;

  // Web Audio context.
  var mAudioContext;
  var mScriptNode;
  var mDestination;  // The node the jammer connects to (masterGain or .destination)
  var mSampleRate;
  var mRateScale;

  // Most recently generated output block (soundbox rewrite addition, not
  // upstream SoundBox): captured in onaudioprocess below so this.getData()
  // can hand a live waveform to the scope panel, the same way player.js's
  // CPlayer.getData(t, n) already does for rendered song playback.
  var mLastLeft, mLastRight;


  //--------------------------------------------------------------------------
  // Sound synthesis engine.
  //--------------------------------------------------------------------------

  // Oscillators.
  var osc_sin = function (value) {
    return Math.sin(value * 6.283184);
  };

  var osc_saw = function (value) {
    return 2 * (value % 1) - 1;
  };

  var osc_square = function (value) {
    return (value % 1) < 0.5 ? 1 : -1;
  };

  var osc_tri = function (value) {
    var v2 = (value % 1) * 4;
    if(v2 < 2) return v2 - 1;
    return 3 - v2;
  };

  var getnotefreq = function (n) {
    return (174.614115728 / mSampleRate) * Math.pow(2, (n-128)/12);
  };

  // Array of oscillator functions.
  var mOscillators = [
    osc_sin,
    osc_square,
    osc_saw,
    osc_tri
  ];
  
  // --- the v2 envelope, shared with src/js/core/voxby.js -------------------
  // The same three functions that player has, on the same parameters, so a
  // preview and the rendered song agree about what a note does.

  // SoundBox's curve: 1 at t = 0, 0 at t = 1, bent by k. Used for both the
  // decay and the release, so the two share a character.
  var curve = function (t, k) {
    return (1 - t) * Math.pow(3, k * t);
  };

  // The envelope level while the gate is open: attack, then decay to the
  // sustain level, then hold there.
  var envOpen = function (j, attack, decay, sustainLvl, expDecay) {
    if (j < attack) return attack ? j / attack : 1;
    if (j < attack + decay) {
      return sustainLvl + (1 - sustainLvl) * curve((j - attack) / decay, expDecay);
    }
    return sustainLvl;
  };

  // Close a note's gate. The release starts from wherever the envelope had got
  // to, so letting go during the attack does not jump to full volume first.
  var releaseVoice = function (note, attack, decay, sustainLvl, expDecay) {
    if (!note.gate) return;
    note.relLevel = envOpen(note.env, attack, decay, sustainLvl, expDecay);
    note.relAt = note.env;
    note.gate = 0;
  };

  // The envelope parameters of a note, in the shape the two functions above
  // want. Read in more than one place, so worked out in one.
  var envOf = function (note) {
    return [
      Math.round(note.instr[10] * note.instr[10] * 4 * mRateScale),
      Math.round(note.instr[11] * note.instr[11] * 4 * mRateScale),
      note.instr[12] / 255,
      -note.instr[14] / 16,
    ];
  };

  var clearFilterState = function()
  {
    if (mDlyLeft)
      mDlyLeft.fill(0);
    if (mDlyRight)
      mDlyRight.fill(0);    
    mFXState = {
      pos: 0,
      low: 0,
      band: 0,
      filterActive: false,
      dlyPos: 0
    };
  }

  // Fill the buffer with more audio, and advance state accordingly.
  var generateTimeSlice = function (leftBuf, rightBuf) {
    var numSamples = rightBuf.length;

    // Local variables
    var i, j, k, b, p, row, col, n, cp,
        t, lfor, e, x, rsample, rowStartSample, f, da;

    // Clear buffers
    for (k = 0; k < numSamples; ++k) {
      leftBuf[k] = 0;
      rightBuf[k] = 0;
    }
    
    if (mRequestClearFilter)
    {
      clearFilterState();
      mRequestClearFilter = false;
    } 

    // Generate active notes.
    for (i = 0; i < MAX_POLYPHONY; ++i) {
      var note = mPlayingNotes[i];
      if (note != undefined) {
        var osc1 = mOscillators[note.instr[0]],
            o1vol = note.instr[1],
            o1xenv = note.instr[3]/32,
            osc2 = mOscillators[note.instr[4]],
            o2vol = note.instr[5],
            o2xenv = note.instr[8]/32,
            noiseVol = note.instr[9],
            // v2's ADSR. The three times are indices, squared and scaled the
            // same way the offline players do it; the sustain level is a
            // straight 0..1 fraction.
            attack = Math.round(note.instr[10] * note.instr[10] * 4 * mRateScale),
            decay = Math.round(note.instr[11] * note.instr[11] * 4 * mRateScale),
            sustainLvl = note.instr[12] / 255,
            release = Math.round(note.instr[13] * note.instr[13] * 4 * mRateScale),
            expDecay = -note.instr[14]/16,
            arpInterval = mRowLen * Math.pow(2, 2 - note.instr[16]);

        // Note frequencies (defined later) and arpeggio
        var o1f, o2f;
        var arp = note.arp, arpSamples = note.arpSamples;

        // Current oscillator state.
        var o1t = note.o1t, o2t = note.o2t;

        // A key held down longer than this is released anyway. Every key-down
        // is supposed to get a matching key-up, but a window that loses focus
        // mid-chord never sends one -- and with v2 a sustaining voice that is
        // never released would drone until the page is reloaded. Ten seconds
        // is far longer than anyone holds a preview and short enough to be a
        // usable escape.
        if (note.gate && note.env > 10 * mSampleRate) {
          releaseVoice(note, attack, decay, sustainLvl, expDecay);
        }

        for (j = note.env, k = 0; k < numSamples; j++, k++) {
          if (arpSamples >= 0 || k == 0) {
            if (arpSamples >= 0) {
              // Switch arpeggio note
              arp = (arp >> 8) | ((arp & 255) << 4);
              arpSamples -= arpInterval;
            }

            // Calculate note frequencies for the oscillators
            o1f = getnotefreq(note.n + (arp & 15) + note.instr[2] - 128);
            o2f = getnotefreq(note.n + (arp & 15) + note.instr[6] - 128) * (1 + 0.0008 * note.instr[7]);
          }
          arpSamples++;

          // Envelope. While the gate is open it runs attack -> decay -> hold;
          // once the key is up it falls from wherever it had got to.
          if (note.gate) {
            e = envOpen(j, attack, decay, sustainLvl, expDecay);
          } else {
            e = note.relLevel * curve((j - note.relAt) / release, expDecay);
          }

          // Oscillator 1
          o1t += o1f * Math.pow(e,o1xenv);
          rsample = osc1(o1t) * o1vol;

          // Oscillator 2
          o2t += o2f * Math.pow(e,o2xenv);
          rsample += osc2(o2t) * o2vol;

          // Noise oscillator
          if (noiseVol) {
            rsample += (2 * Math.random() - 1) * noiseVol;
          }

          // Add to (mono) channel buffer
          rightBuf[k] += 0.002441481 * rsample * e;

          // End of note: released and past its release, or holding at nothing
          // because the instrument has no sustain level -- which is how a
          // percussive preview ends without a key-up at all.
          if (note.gate ? (sustainLvl <= 0 && j >= attack + decay)
                        : (j - note.relAt >= release)) {
            mPlayingNotes[i] = undefined;
            k = numSamples;
          }
        }

        // Save state.
        note.env = j;
        note.arp = arp;
        note.arpSamples = arpSamples;
        note.o1t = o1t;
        note.o2t = o2t;
      }
    }

    // And the effects...
    var pos = mFXState.pos,
        low = mFXState.low,
        band = mFXState.band,
        filterActive = mFXState.filterActive,
        dlyPos = mFXState.dlyPos;
    var lsample, high, dlyRead, dlyMask = MAX_DELAY - 1;

    // Put performance critical strip properties in local variables. These are
    // the channel's own 13 effect parameters in v2, not the tail of one
    // 28-number instrument -- see engine2.js.
    var oscLFO = mOscillators[mFx[0]],
        lfoAmt = mFx[1] / 512,
        lfoFreq = Math.pow(2, mFx[2] - 9) / mRowLen,
        fxLFO = mFx[3],
        fxFilter = mFx[4],
        fxFreq = mFx[5] * 43.23529 * 3.141592 / mSampleRate,
        q = 1 - mFx[6] / 255,
        dist = mFx[7] * 1e-5 * 32767,
        drive = mFx[8] / 32,
        panAmt = mFx[9] / 512,
        panFreq = 6.283184 * Math.pow(2, mFx[10] - 9) / mRowLen,
        dlyAmt = mFx[11] / 255,
        dly = (mFx[12] * mRowLen) >> 1;

    // Limit the delay to the delay buffer size.
    if (dly >= MAX_DELAY) {
      dly = MAX_DELAY - 1;
    }

    // Perform effects for this time slice
    for (j = 0; j < numSamples; j++) {
      k = (pos + j) * 2;

      // Dry mono-sample.
      rsample = rightBuf[j];

      // We only do effects if we have some sound input.
      if (rsample || filterActive) {
        // State variable filter.
        f = fxFreq;
        if (fxLFO) {
          f *= oscLFO(lfoFreq * k) * lfoAmt + 0.5;
        }
        f = 1.5 * Math.sin(f);
        low += f * band;
        high = q * (rsample - band) - low;
        band += f * high;
        rsample = fxFilter == 3 ? band : fxFilter == 1 ? high : low;

        // Distortion.
        if (dist) {
          rsample *= dist;
          rsample = rsample < 1 ? rsample > -1 ? osc_sin(rsample*.25) : -1 : 1;
          rsample /= dist;
        }

        // Drive.
        rsample *= drive;

        // Is the filter active (i.e. still audiable)?
        filterActive = rsample * rsample > 1e-5;

        // Panning.
        t = Math.sin(panFreq * k) * panAmt + 0.5;
        lsample = rsample * (1 - t);
        rsample *= t;
      } else {
        lsample = 0;
      }

      // Delay is always done, since it does not need sound input.
      dlyRead = (dlyPos - dly) & dlyMask;
      lsample += mDlyRight[dlyRead] * dlyAmt;
      rsample += mDlyLeft[dlyRead] * dlyAmt;
      mDlyLeft[dlyPos] = lsample;
      mDlyRight[dlyPos] = rsample;
      dlyPos = (dlyPos + 1) & dlyMask;

      // Store wet stereo sample.
      leftBuf[j] = lsample;
      rightBuf[j] = rsample;
    }

    // Update effect sample position.
    pos += numSamples;

    // Prevent rounding problems...
    while (pos > mRowLen * 2048) {
      pos -= mRowLen * 2048;
    }

    // Store filter state.
    mFXState.pos = pos;
    mFXState.low = low;
    mFXState.band = band;
    mFXState.filterActive = filterActive;
    mFXState.dlyPos = dlyPos;
  };


  //--------------------------------------------------------------------------
  // Public interface.
  //--------------------------------------------------------------------------

  // Soundbox rewrite addition (not upstream SoundBox): takes a shared
  // AudioContext (tools/soundbox/audio.js) instead of creating a private
  // one, so the jammer and rendered song playback (main.js) share a single
  // audio graph and a single autoplay-policy unlock -- main.js's startup
  // gate modal is that unlock gesture now, so this file no longer needs
  // (and doesn't install) its own "resume on first click" listener like
  // upstream SoundBox did.
  //
  // `destination` param added for master volume support: the jammer now
  // connects to an intermediate GainNode (panels/keyboard.js's jammerGain)
  // instead of directly to ctx.destination, so the master volume slider
  // (main.js) can scale both rendered songs and live jamming at once.
  this.start = function (ctx, destination) {
    mAudioContext = ctx;
    mDestination = destination || ctx.destination;

    // Backwards compat (e.g. Safari).
    if (!mAudioContext.createScriptProcessor) {
      if (mAudioContext.createJavaScriptNode) {
        mAudioContext.createScriptProcessor = mAudioContext.createJavaScriptNode;
      } else {
        mAudioContext = undefined;
        return;
      }
    }

    // Get actual sample rate (SoundBox is hard-coded to 44100 samples/s).
    mSampleRate = mAudioContext.sampleRate;
    mRateScale = mSampleRate / 44100;

    // Create delay buffers (lengths must be equal and a power of 2).
    mDlyLeft = new Float32Array(MAX_DELAY);
    mDlyRight = new Float32Array(MAX_DELAY);

    // Clear state.
    clearFilterState();

    // Create a script processor node with no inputs and one stereo output.
    // Soundbox rewrite addition: buffer size dropped from upstream's 2048
    // to 1024 -- halves the interval between onaudioprocess callbacks
    // (~46ms -> ~23ms), which is how often mLastLeft/mLastRight (and
    // therefore the scope's live jammer waveform) actually get fresh
    // samples. This synth's per-sample cost is tiny, so the extra callback
    // frequency costs effectively nothing.
    mScriptNode = mAudioContext.createScriptProcessor(1024, 0, 2);
    mScriptNode.onaudioprocess = function (event) {
      var leftBuf = event.outputBuffer.getChannelData(0);
      var rightBuf = event.outputBuffer.getChannelData(1);
      generateTimeSlice(leftBuf, rightBuf);
      mLastLeft = leftBuf;
      mLastRight = rightBuf;
    };

    // Connect the script node to the output (or the destination passed to start()).
    mScriptNode.connect(mDestination);
  };

  this.stop = function () {
    // TODO(m): Implement me!
  };

  // Soundbox rewrite addition (not upstream SoundBox): the last `n`
  // interleaved L/R samples this jammer generated, i.e. whatever's audible
  // right now from on-screen/physical-keyboard note preview. Signature
  // matches player.js's CPlayer.getData(t, n) so panels/scope.js can treat
  // either as an interchangeable sample source -- `t` is unused here since
  // this is always "now", not a seekable rendered buffer.
  this.getData = function (t, n) {
    var d = [], len = mLastLeft ? mLastLeft.length : 0, start = len - n;
    for (var j = 0; j < n; ++j) {
      var i = start + j;
      d.push(i >= 0 && i < len ? mLastLeft[i] : 0, i >= 0 && i < len ? mLastRight[i] : 0);
    }
    return d;
  };

  // The voice (17 numbers) and the channel strip (13) that a preview plays
  // through. Two arrays in v2, where there used to be one of 28.
  this.updateInstr = function (voice, fx) {
    var diffCount = 0, i;
    if (voice && mInstr)
      for (i = 0; i < voice.length; ++i)
        diffCount += mInstr[i] != voice[i] ? 1 : 0;
    if (fx && mFx)
      for (i = 0; i < fx.length; ++i)
        diffCount += mFx[i] != fx[i] ? 1 : 0;
    // if more than one setting changed at once, the user is probably not
    // making minor adjustments but quite large ones (e.g. loading a new
    // preset). Prevent accidental deafness by stopping notes
    if (diffCount >= 2)
      this.clearNotes();
    mInstr = deepCopy(voice);
    mFx = deepCopy(fx);
  };

  this.updateRowLen = function (rowLen) {
    mRowLen = Math.round(rowLen * mRateScale);
  };
  
  this.clearNotes = function() {
    for (var i = 0; i < MAX_POLYPHONY; ++i)             
      mPlayingNotes[i] = undefined;
    mRequestClearFilter = true;
  };

  this.addNote = function (n) {
    var t = (new Date()).getTime();

    // Create a new note object. `gate` is open until releaseNote closes it;
    // relAt/relLevel are where the release starts from when it does.
    var note = {
      startT: t,
      env: 0,
      gate: 1,
      relAt: 0,
      relLevel: 0,
      arp: mInstr[15],
      arpSamples: 0,
      o1t: 0,
      o2t: 0,
      n: n,
      instr: new Array(mInstr.length)
    };

    // Copy (snapshot) the current instrument.
    for (var i = 0; i < mInstr.length; ++i) {
      note.instr[i] = mInstr[i];
    }

    // Find an empty channel, or replace the oldest note.
    var oldestIdx = 0;
    var oldestDt = -100;
    for (var i = 0; i < MAX_POLYPHONY; ++i) {
      // If the channel is currently free - use it.
      if (mPlayingNotes[i] == undefined) {
        mPlayingNotes[i] = note;
        return;
      }

      // Check if this channel has the oldest playing note.
      var dt = t - mPlayingNotes[i].startT;
      if (dt > oldestDt) {
        oldestIdx = i;
        oldestDt = dt;
      }
    }

    // All channels are playing - replace the oldest one.
    mPlayingNotes[oldestIdx] = note;
  };

  // Let go of pitch `n`: close the gate on the most recently started voice
  // still holding it, so it falls through its release instead of stopping
  // dead. The newest rather than any of them, so playing the same pitch twice
  // and letting go once releases the note that key is holding.
  //
  // A percussive voice (no sustain level) has usually finished on its own
  // before this arrives, and releasing an already-released voice is a no-op,
  // so no caller has to check first.
  this.releaseNote = function (n) {
    var newest = -1, newestT = -1;
    for (var i = 0; i < MAX_POLYPHONY; ++i) {
      var note = mPlayingNotes[i];
      if (note != undefined && note.gate && note.n === n && note.startT > newestT) {
        newest = i;
        newestT = note.startT;
      }
    }
    if (newest < 0) return;
    var note = mPlayingNotes[newest], env = envOf(note);
    releaseVoice(note, env[0], env[1], env[2], env[3]);
  };

  // Let go of everything still held, for a window that loses focus mid-chord.
  this.releaseAll = function () {
    for (var i = 0; i < MAX_POLYPHONY; ++i) {
      var note = mPlayingNotes[i];
      if (note != undefined && note.gate) {
        var env = envOf(note);
        releaseVoice(note, env[0], env[1], env[2], env[3]);
      }
    }
  };

};

