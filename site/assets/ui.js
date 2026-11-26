// Pieces the hero demo and the section demos share: elements, thread rows,
// the pointer dot, cancellable waits and the one play on first view.
import { stepWords } from './flow.js';

const SVG = 'http://www.w3.org/2000/svg';

export class Cancelled extends Error {}

export function make(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function button(label, className, onClick) {
  const element = make('button', className, label);
  element.type = 'button';
  if (onClick) element.addEventListener('click', onClick);
  return element;
}

/** Swaps a static element of a picture for a button with the same look and content. */
export function toButton(element, label) {
  const replacement = make('button', `vbtn ${element.className}`, ...element.childNodes);
  replacement.type = 'button';
  if (label) replacement.setAttribute('aria-label', label);
  element.replaceWith(replacement);
  return replacement;
}

/** The one line in a demo's stage that says what to do. */
export function addHint(stage, text) {
  const hint = make('p', 'stage-hint', text);
  stage.append(hint);
  return hint;
}

/** A stage whose controls are real now, so assistive technology may see it. */
export function upgrade(stage) {
  stage.removeAttribute('aria-hidden');
  stage.classList.add('is-live');
}

/** The ochre flash of a tap. */
export function flash(element) {
  element.classList.remove('is-tap');
  void element.offsetWidth;
  element.classList.add('is-tap');
  setTimeout(() => element.classList.remove('is-tap'), 600);
}

/** A step as a row on the thread: its mark, kind word, words, and optionally the selector and a thumbnail slot. */
export function stepRow(step, number, { selector = true, thumb = false } = {}) {
  const words = stepWords(step);
  const row = make('li', 'step');
  row.dataset.kind = words.kind;
  const what = make('span', 'what', make('span', 'line', make('span', 'words', words.text)));
  if (selector && words.selector) what.append(make('code', 'sel', words.selector));
  row.append(make('span', 'mark', String(number)), make('span', 'kind', words.kind), what);
  if (thumb) {
    const slot = make('span', 'thumb');
    slot.setAttribute('aria-hidden', 'true');
    slot.inert = true;
    row.append(slot);
  }
  return row;
}

/** Adds a row that slides in with a flash of its mark, and lets the oldest rows go past `keep`. */
export function appendRow(list, row, { keep = Infinity, reducedMotion = false } = {}) {
  row.classList.add('is-new');
  row.addEventListener('animationend', () => row.classList.remove('is-new'), { once: true });
  list.append(row);
  const rows = [...list.children].filter((child) => !child.classList.contains('is-leaving'));
  for (const old of rows.slice(0, Math.max(0, rows.length - keep))) {
    if (reducedMotion) {
      old.remove();
      continue;
    }
    old.classList.add('is-leaving');
    const height = old.offsetHeight;
    old
      .animate(
        [
          { height: `${height}px`, opacity: 1 },
          { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' },
        ],
        { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' },
      )
      .finished.then(() => old.remove());
  }
}

/**
 * A wait that rejects with Cancelled once `alive()` turns false, so a scripted
 * play stops at its next pause when the visitor steps in.
 */
export function sleeper(alive) {
  return (ms) =>
    new Promise((resolve, reject) => {
      setTimeout(() => (alive() ? resolve() : reject(new Cancelled())), ms);
    });
}

/** The ochre dot that stands in for a pointer while a demo plays itself. */
export function createPointer(frame, element = frame.appendChild(make('span', 'demo-pointer'))) {
  element.setAttribute('aria-hidden', 'true');
  const place = (x, y) => (element.style.transform = `translate(${x}px, ${y}px)`);
  return {
    element,
    /** Moves to the middle of `target`, or to `at` (a point in the target's own box), and waits for the move. */
    at(target, wait, { travelMs = 560, offset } = {}) {
      const box = frame.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (!element.classList.contains('is-shown')) {
        // Appear low in the middle of the frame, then travel.
        element.style.transition = 'none';
        place(box.width * 0.52, box.height * 0.82);
        void element.offsetWidth;
        element.style.transition = '';
        element.classList.add('is-shown');
      }
      const x = offset ? offset.x : rect.width / 2;
      const y = offset ? offset.y : rect.height / 2;
      place(rect.left - box.left + x, rect.top - box.top + y);
      return wait(travelMs);
    },
    async press(wait) {
      element.classList.add('is-down');
      await wait(130);
      element.classList.remove('is-down');
    },
    hide() {
      element.classList.remove('is-shown');
    },
  };
}

/**
 * Runs `play` once, the first time at least half of `element` is on screen in a
 * visible tab. Never with reduced motion.
 */
export function onFirstView(element, play, { reducedMotion }) {
  if (reducedMotion || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.5 || document.hidden) return;
      observer.disconnect();
      play();
    },
    { threshold: [0.5, 0.75, 1] },
  );
  observer.observe(element);
}

/**
 * A demo's one play: `run(wait)` with a wait that stops once the visitor
 * clicks or presses a key inside `zone`. Their action then goes ahead.
 */
export function playOnceOnView(zone, run, { reducedMotion, pointer }) {
  let playing = false;
  const stop = (event) => {
    if (!playing || !event.isTrusted) return;
    playing = false;
    pointer.hide();
  };
  zone.addEventListener('click', stop, { capture: true });
  zone.addEventListener('keydown', stop, { capture: true });
  onFirstView(
    zone,
    async () => {
      playing = true;
      try {
        await run(sleeper(() => playing));
      } catch (error) {
        if (!(error instanceof Cancelled)) throw error;
      } finally {
        if (playing) pointer.hide();
        playing = false;
      }
    },
    { reducedMotion },
  );
  return { isPlaying: () => playing };
}
