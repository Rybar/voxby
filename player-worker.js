/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2013 Marcus Geelnard
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

// Worker glue for player-core.js. The renderer itself moved there so the main
// thread can use it too (panels/sfx-view.js renders one short sound and wants
// its waveform straight away, not a round trip); this file is what makes it a
// worker, and nothing else.
//
// A module worker, so it can import: player.js starts it with
// { type: "module" }.

import { CPlayerWorker } from './player-core.js';

const gPlayerWorker = new CPlayerWorker();
gPlayerWorker.onProgress = progress => postMessage({ cmd: "progress", progress, buffer: null });

onmessage = function (event) {
  if (event.data.cmd === "generate") {
    // Generate the sound data.
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
