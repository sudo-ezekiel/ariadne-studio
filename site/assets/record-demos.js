// The three small demos in the Record section: picking a selector, the phone
// buttons and swipes, and Check. Each starts from the page's static picture,
// turns its parts into real controls, and plays once the first time it is seen.
import { describeSelector, pointSelector, selectorFor } from './flow.js';
import { addHint, appendRow, createPointer, flash, make, playOnceOnView, stepRow, toButton, upgrade } from './ui.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Selectors: what a step would use for each element, read off as the pointer moves.
function initSelectors(stage, { reducedMotion }) {
  const readout = stage.querySelector('.readout');
  const code = readout.querySelector('code');
  const save = toButton(stage.querySelector('.ag-icon-btn.is-picked'), 'Save');
  const reminder = toButton(stage.querySelector('.ag-row-mini'), '10 minutes before');
  const map = toButton(stage.querySelector('.ag-map'), 'Map');
  const note = make('p', 'readout-note', 'Tapped by position. Look at this step before you trust it.');
  note.hidden = true;
  readout.after(note);
  readout.id = 'selectors-readout';
  note.id = 'selectors-note';
  addHint(stage, 'Point at something on the screen');
  upgrade(stage);

  const pick = (target, point = { x: 50, y: 50 }) => {
    for (const element of [save, reminder, map]) element.classList.toggle('is-picked', element === target);
    const selector = target === save ? selectorFor({ id: 'save' }) : target === reminder ? selectorFor({ text: '10 minutes before' }) : pointSelector(point.x, point.y);
    code.textContent = describeSelector(selector);
    note.hidden = target !== map;
  };
  // Percent of the map's width and height under the pointer, in whole numbers.
  const mapPoint = (event) => {
    const box = map.getBoundingClientRect();
    const clamp = (value) => Math.min(100, Math.max(0, value));
    return { x: clamp(((event.clientX - box.left) / box.width) * 100), y: clamp(((event.clientY - box.top) / box.height) * 100) };
  };
  for (const target of [save, reminder]) {
    target.setAttribute('aria-describedby', readout.id);
    for (const type of ['pointerenter', 'focus', 'click']) target.addEventListener(type, () => pick(target));
  }
  map.setAttribute('aria-describedby', `${readout.id} ${note.id}`);
  map.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'touch') pick(map, mapPoint(event));
  });
  map.addEventListener('focus', () => pick(map));
  // A touch has no hover to aim with, so it takes the middle, like a keyboard press.
  map.addEventListener('click', (event) => pick(map, event.pointerType === 'mouse' || event.pointerType === 'pen' ? mapPoint(event) : undefined));

  const pointer = createPointer(stage);
  playOnceOnView(
    stage,
    async (wait) => {
      await wait(400);
      await pointer.at(reminder, wait);
      pick(reminder);
      await wait(900);
      const box = map.getBoundingClientRect();
      await pointer.at(map, wait, { offset: { x: box.width * 0.3, y: box.height * 0.55 } });
      pick(map, { x: 30, y: 55 });
      await wait(400);
      await pointer.at(map, wait, { offset: { x: box.width * 0.62, y: box.height * 0.4 }, travelMs: 700 });
      pick(map, { x: 62, y: 40 });
      await wait(1400);
      await pointer.at(save, wait);
      pick(save);
      await wait(900);
    },
    { reducedMotion, pointer },
  );
}

// Gestures: each phone button and each swipe adds a step; the list keeps its newest three.
function initGestures(stage, { reducedMotion }) {
  const list = stage.querySelector('.steps-mini');
  const bar = stage.querySelector('.keys-full');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Phone buttons');
  let number = list.children.length;
  let orientation = 'LANDSCAPE_LEFT';
  let month = 10;

  const add = (step) => {
    number += 1;
    appendRow(list, stepRow(step, number, { selector: false }), { keep: 3, reducedMotion });
  };

  const STEPS = {
    Back: () => ({ kind: 'back' }),
    Home: () => ({ kind: 'key', key: 'Home' }),
    'Vol down': () => ({ kind: 'key', key: 'Volume Down' }),
    'Vol up': () => ({ kind: 'key', key: 'Volume Up' }),
    Power: () => ({ kind: 'key', key: 'Power' }),
    Enter: () => ({ kind: 'key', key: 'Enter' }),
    Rotate: () => {
      orientation = orientation === 'PORTRAIT' ? 'LANDSCAPE_LEFT' : 'PORTRAIT';
      return { kind: 'rotate', orientation };
    },
  };
  const keys = {};
  for (const span of [...bar.querySelectorAll('.key')]) {
    const name = span.textContent.trim();
    const key = toButton(span);
    keys[name] = key;
    if (name === 'Recents') {
      const reason = 'Off while recording: Maestro cannot replay this';
      const description = make('span', 'sr-only', reason);
      description.id = 'gestures-recents-reason';
      key.after(description);
      key.title = reason;
      key.setAttribute('aria-disabled', 'true');
      key.setAttribute('aria-describedby', description.id);
      continue;
    }
    key.addEventListener('click', () => {
      flash(key);
      add(STEPS[name]());
    });
  }

  // A strip of the calendar's screen to swipe: left shows the next month, right the one before.
  const label = make('span', 'swipe-month', MONTHS[month]);
  const strip = make('div', 'swipe-strip', make('span', 'swipe-edge', '‹'), label, make('span', 'swipe-edge', '›'));
  strip.tabIndex = 0;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-roledescription', 'swipe area');
  const describe = () => strip.setAttribute('aria-label', `Calendar month: ${MONTHS[month]}. Drag it, or press the left or right arrow key, to swipe`);
  describe();
  bar.after(strip);

  const swipe = (direction) => {
    const step = direction === 'LEFT' ? 1 : -1;
    month = (month + step + 12) % 12;
    const out = direction === 'LEFT' ? '-60%' : '60%';
    const change = () => {
      label.textContent = MONTHS[month];
      describe();
    };
    if (reducedMotion) change();
    else {
      label.animate([{ transform: label.style.transform || 'none' }, { transform: `translateX(${out})`, opacity: 0 }], { duration: 160, easing: 'ease-in' }).finished.then(() => {
        change();
        label.style.transform = '';
        label.animate([{ transform: `translateX(${direction === 'LEFT' ? '60%' : '-60%'})`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
      });
    }
    add({ kind: 'swipe', direction });
  };

  let drag = null;
  strip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX };
    strip.setPointerCapture(event.pointerId);
    strip.classList.add('is-dragging');
  });
  strip.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    label.style.transform = `translateX(${(event.clientX - drag.x) * 0.6}px)`;
  });
  const end = (event, cancelled) => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    drag = null;
    strip.classList.remove('is-dragging');
    if (!cancelled && Math.abs(dx) > 36) swipe(dx < 0 ? 'LEFT' : 'RIGHT');
    else label.style.transform = '';
  };
  strip.addEventListener('pointerup', (event) => end(event, false));
  // A vertical thumb drag scrolls the page instead (touch-action: pan-y), which cancels the swipe.
  strip.addEventListener('pointercancel', (event) => end(event, true));
  strip.addEventListener('keydown', (event) => {
    const direction = { ArrowLeft: 'LEFT', ArrowRight: 'RIGHT' }[event.key];
    if (!direction) return;
    event.preventDefault();
    swipe(direction);
  });

  addHint(stage, 'Press a phone button, or drag across the screen');
  upgrade(stage);

  const pointer = createPointer(stage);
  playOnceOnView(
    stage,
    async (wait) => {
      await wait(400);
      await pointer.at(keys.Back, wait);
      await pointer.press(wait);
      keys.Back.click();
      await wait(700);
      const box = strip.getBoundingClientRect();
      await pointer.at(strip, wait, { offset: { x: box.width * 0.75, y: box.height / 2 } });
      pointer.element.classList.add('is-down');
      label.style.transition = 'transform 500ms cubic-bezier(.2,.7,.2,1)';
      label.style.transform = 'translateX(-40px)';
      await pointer.at(strip, wait, { offset: { x: box.width * 0.25, y: box.height / 2 }, travelMs: 520 });
      pointer.element.classList.remove('is-down');
      label.style.transition = '';
      swipe('LEFT');
      await wait(800);
      await pointer.at(keys.Rotate, wait);
      await pointer.press(wait);
      keys.Rotate.click();
      await wait(700);
    },
    { reducedMotion, pointer },
  );
}

// Check: with Check on a click records what must be on the screen; with it off a click is a tap.
function initCheck(stage, { reducedMotion }) {
  const list = stage.querySelector('.steps-mini');
  const toggle = toButton(stage.querySelector('.check-toggle'));
  toggle.classList.remove('is-on');
  toggle.setAttribute('aria-pressed', 'true');
  const hint = addHint(stage, '');
  let number = Number(list.querySelector('.mark').textContent);
  stage.querySelector('.is-checked')?.classList.remove('is-checked');

  const targets = [...stage.querySelectorAll('.ag-sheet .ag-title, .ag-sheet .ag-time, .ag-sheet .ag-event-title')].map((element) => {
    const target = toButton(element);
    target.classList.add('check-target');
    return target;
  });
  const vignette = stage.querySelector('.vignette-check');
  const render = () => {
    const on = toggle.getAttribute('aria-pressed') === 'true';
    vignette.classList.toggle('is-checking', on);
    hint.textContent = on ? 'Check is on: click what must be on the screen' : 'Check is off: a click is a tap';
    return on;
  };
  render();
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
    render();
  });
  for (const target of targets) {
    target.addEventListener('click', () => {
      const on = render();
      const name = target.textContent.trim();
      const selector = selectorFor({ text: name });
      for (const other of targets) other.classList.toggle('is-checked', on && other === target);
      flash(target);
      number += 1;
      appendRow(list, stepRow(on ? { kind: 'check', selector, name } : { kind: 'tap', selector, name }, number, { selector: false }), { keep: 2, reducedMotion });
    });
  }
  upgrade(stage);

  const pointer = createPointer(stage);
  const byName = (name) => targets.find((target) => target.textContent.trim() === name);
  playOnceOnView(
    stage,
    async (wait) => {
      await wait(400);
      await pointer.at(byName('Team standup'), wait);
      await pointer.press(wait);
      byName('Team standup').click();
      await wait(900);
      await pointer.at(toggle, wait);
      await pointer.press(wait);
      toggle.click();
      await wait(600);
      await pointer.at(byName('Dentist'), wait);
      await pointer.press(wait);
      byName('Dentist').click();
      await wait(900);
      await pointer.at(toggle, wait);
      await pointer.press(wait);
      toggle.click();
      await wait(600);
    },
    { reducedMotion, pointer },
  );
}

export function initRecordDemos(options) {
  const find = (name) => document.querySelector(`[data-demo="${name}"]`);
  if (find('selectors')) initSelectors(find('selectors'), options);
  if (find('gestures')) initGestures(find('gestures'), options);
  if (find('check')) initCheck(find('check'), options);
}
