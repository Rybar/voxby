// Generic popup menu, used for the pattern grid's right-click transpose menu.
// Deliberately not a panel and not tracker-aware: openMenu() takes a position
// and a list of {label, hint, run} items, so anything else wanting a context
// menu reuses this rather than growing a second one.
//
// Same overlay technique as panels/pie.js -- a full-viewport div that catches
// the dismissing click, with the actual menu positioned inside it -- but the
// items are real <button>s here, since a list wants keyboard/hover semantics
// for free where the pie's wedges needed geometry.

const CLOSE_EVENTS = ['mousedown', 'wheel', 'contextmenu'];

let openEl = null;

export function closeMenu() {
  if (!openEl) return;
  document.removeEventListener('keydown', onKey, true);
  openEl.remove();
  openEl = null;
}

function onKey(e) {
  if (e.code === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); }
}

// `items` entries are { label, hint, run } -- `hint` is the keyboard shortcut
// shown right-aligned, `run` is called after the menu closes (so a handler is
// free to open another one). A falsy entry becomes a separator, which is how a
// caller groups items without knowing this module's markup.
export function openMenu(x, y, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu-overlay';
  el.innerHTML = `<div class="menu">${items.map((it, i) => it
    ? `<button class="menu-item" data-i="${i}" type="button">${it.label}<span class="menu-hint">${it.hint || ''}</span></button>`
    : '<div class="menu-sep"></div>').join('')}</div>`;
  document.body.appendChild(el);
  openEl = el;

  // Placed after insertion so the real measured size can be flipped back
  // inside the viewport rather than guessed from the item count.
  const menu = el.firstElementChild, r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';

  for (const btn of menu.querySelectorAll('.menu-item')) {
    // click, not mousedown: the overlay's own mousedown handler below is what
    // dismisses the menu, and a mousedown here would race it.
    btn.onclick = () => {
      const item = items[+btn.dataset.i];
      closeMenu();
      item.run();
    };
  }
  // A press anywhere outside the menu itself dismisses without running
  // anything -- including a right-click, which is how you move the menu
  // somewhere else in one gesture.
  for (const type of CLOSE_EVENTS) {
    el.addEventListener(type, e => {
      if (e.target.closest('.menu')) return;
      e.preventDefault();
      closeMenu();
    });
  }
  document.addEventListener('keydown', onKey, true);
}
