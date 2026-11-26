// The hero's working model of the studio: record a case on the Agenda phone,
// watch the steps and the Maestro flow being written, then run it. It plays a
// case by itself while in view, through the same functions a visitor's clicks
// reach, until the visitor clicks or types in the phone or the panel.
import { APP_ID, escapeMaestroRegex, formatDuration, notFoundMessage, selectorFor, stepWords, toMaestroYaml } from './flow.js';
import { createAgenda, nodeName } from './agenda.js';
import { Cancelled, button, createPointer, icon, make, stepRow } from './ui.js';

const CASE_NAME = 'Create an event';

// What a run reports for each step, by kind, in the order steps of that kind come.
const DURATIONS = {
  start: [2800],
  tap: [1600, 1200, 1900, 1400, 1100],
  type: [2900, 2600, 2200],
  check: [1200, 900],
  back: [700, 800],
  key: [600, 700],
};
// Maestro gives a missing element this long before it fails the step.
const NOT_FOUND_MS = 17100;

function durations() {
  const seen = {};
  return (kind) => {
    const list = DURATIONS[kind];
    seen[kind] = (seen[kind] ?? -1) + 1;
    return list[seen[kind] % list.length];
  };
}

function stepCount(n) {
  return n === 1 ? '1 step' : `${n} steps`;
}

/** One line of the flow file with its keys, strings and punctuation marked. */
function yamlLine(text) {
  const line = make('span', 'ln');
  if (text === '---') {
    line.append(make('span', 'p', text));
    return line;
  }
  const match = /^(\s*)(- )?([A-Za-z]+)(:?)(.*)$/.exec(text);
  if (!match) {
    line.textContent = text;
    return line;
  }
  const [, indent, dash, key, colon, rest] = match;
  if (indent) line.append(indent);
  if (dash) line.append(make('span', 'p', dash));
  if (!colon) {
    line.append(key + rest);
    return line;
  }
  line.append(make('span', 'k', key), ':');
  const value = rest.trimStart();
  if (value) line.append(' ', value.startsWith('"') ? make('span', 's', value) : value);
  return line;
}

function matches(node, selector) {
  if (selector.kind === 'id') return Boolean(node.dataset.id) && selectorFor({ id: node.dataset.id }).value === selector.value;
  return escapeMaestroRegex(nodeName(node)) === selector.value;
}

export function initStudioDemo(root, { reducedMotion, copyText }) {
  if (!root) return;
  const q = (selector) => root.querySelector(selector);
  const ui = {
    windows: q('.demo-windows'),
    phone: q('[data-phone]'),
    recState: q('[data-rec-state]'),
    recHint: q('[data-rec-hint]'),
    record: q('[data-act="record"]'),
    caption: q('[data-caption]'),
    callout: q('[data-callout]'),
    check: q('[data-act="check"]'),
    keysBar: q('.keys'),
    controls: q('.controls'),
    keys: [...root.querySelectorAll('[data-key]')],
    caseCol: q('.case-col'),
    scroll: q('[data-steps-scroll]'),
    list: q('[data-steps]'),
    foot: q('[data-case-foot]'),
    yaml: q('[data-yaml]'),
    yamlScroll: q('[data-yaml-scroll]'),
    copyYaml: q('[data-copy-yaml]'),
    pointer: q('[data-pointer]'),
    live: q('[data-live]'),
    pause: q('[data-demo-pause]'),
    yourself: q('[data-demo-yourself]'),
    again: q('[data-demo-again]'),
  };
  const app = createAgenda(ui.phone);
  const startRow = ui.list.querySelector('.is-start');
  // The page carries the finished case as static rows for readers without scripts; the script builds its own.
  for (const row of ui.list.querySelectorAll('.step:not(.is-start)')) row.remove();
  const lastValue = new WeakMap();

  const rec = {
    mode: 'idle', // idle, recording, saved or running
    steps: [],
    rows: [],
    check: false,
    session: null, // the field being typed into, and the type step it feeds
    results: null,
    quiet: false, // building a state without animating or announcing it
    yamlLines: [],
    yamlText: '',
    run: null,
  };
  const auto = { on: !reducedMotion, running: false, paused: false, inView: false, cycles: 0 };
  // Every reset moves this on; anything waiting from before stops at its next wait.
  let generation = 0;
  let hovered = null;
  let hintTimer = 0;

  /* Time. Autoplay keeps its own clock, which stands still while paused, out of view or in a hidden tab. */

  const playing = () => !auto.paused && auto.inView && !document.hidden;

  function waiter() {
    const gen = generation;
    if (auto.running) {
      return (ms) =>
        new Promise((resolve, reject) => {
          let left = ms;
          let last = performance.now();
          const tick = (now) => {
            if (gen !== generation) return reject(new Cancelled());
            if (playing()) left -= now - last;
            last = now;
            if (left <= 0) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
    }
    return (ms) => new Promise((resolve, reject) => setTimeout(() => (gen === generation ? resolve() : reject(new Cancelled())), ms));
  }

  /* Saying things */

  function say(text) {
    if (rec.quiet || auto.running) return;
    ui.live.textContent = '';
    setTimeout(() => (ui.live.textContent = text), 30);
  }

  function announceStep(index) {
    const step = rec.steps[index];
    if (step) say(`Step ${index + 1}: ${stepWords(step).text.replace(/"/g, '')}`);
  }

  function hint(text) {
    ui.recHint.textContent = text;
    ui.recHint.classList.add('is-shown');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => ui.recHint.classList.remove('is-shown'), 2600);
  }

  const hintNotRecording = () => hint(rec.mode === 'saved' ? 'Press Start recording to record a new case' : 'Press Start recording first');

  /* The pointer and the outline on the phone */

  function describeNode(node) {
    const target = node.dataset.id ? `${APP_ID}:id/${node.dataset.id}` : `"${nodeName(node)}"`;
    return `${target} ${node.dataset.role}`;
  }

  function renderCaption() {
    ui.caption.classList.toggle('is-check', rec.check);
    if (rec.check) ui.caption.textContent = 'Check: click what must be on the screen';
    else ui.caption.textContent = hovered ? describeNode(hovered) : APP_ID;
  }

  function hover(node) {
    if (hovered === node) return;
    hovered?.classList.remove('is-hover');
    hovered = node;
    node?.classList.add('is-hover');
    renderCaption();
  }

  function flash(node) {
    if (rec.quiet) return;
    node.classList.remove('is-tap');
    void node.offsetWidth;
    node.classList.add('is-tap');
    setTimeout(() => node.classList.remove('is-tap'), 600);
  }

  const pointer = createPointer(ui.windows, ui.pointer);

  function pointAt(target, wait) {
    hover(ui.phone.contains(target) ? target : null);
    return pointer.at(target, wait, { travelMs: reducedMotion ? 120 : 560 });
  }

  const press = (wait) => pointer.press(wait);
  const hidePointer = () => pointer.hide();

  /* Rows */

  function follow(row) {
    const view = ui.scroll.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const behavior = rec.quiet || reducedMotion ? 'auto' : 'smooth';
    // The newest row takes the list to its very end, so a thumb scrolling on past it moves the page.
    if (row === ui.list.lastElementChild && box.bottom > view.bottom) ui.scroll.scrollTo({ top: ui.scroll.scrollHeight, behavior });
    else if (box.bottom > view.bottom) ui.scroll.scrollBy({ top: box.bottom - view.bottom + 8, behavior });
    else if (box.top < view.top) ui.scroll.scrollBy({ top: box.top - view.top - 8, behavior });
  }

  const makeRow = (step, index) => stepRow(step, index + 1, { thumb: true });

  function addStep(step) {
    rec.steps.push(step);
    const index = rec.steps.length - 1;
    const row = makeRow(step, index);
    rec.rows.push(row);
    ui.list.append(row);
    if (!rec.quiet) {
      row.classList.add('is-new');
      row.addEventListener('animationend', () => row.classList.remove('is-new'), { once: true });
      follow(row);
    }
    renderYaml();
    renderBar();
    if (step.kind !== 'type') announceStep(index);
    return index;
  }

  function removeLastStep() {
    rec.steps.pop();
    rec.rows.pop().remove();
    renderYaml();
    renderBar();
  }

  function captureThumb(index) {
    rec.rows[index]?.querySelector('.thumb').replaceChildren(app.snapshot());
  }

  function setResult(row, status, ms, message) {
    row.classList.remove('is-running');
    row.querySelector('.result')?.remove();
    row.querySelector('.msg')?.remove();
    const result = make('span', `result is-${status}`);
    if (status === 'pass') result.append(icon('tick'), 'Passed ', make('span', 'dur', formatDuration(ms)));
    else if (status === 'fail') result.append(icon('cross'), 'Failed ', make('span', 'dur', formatDuration(ms)));
    else result.append('Not run');
    row.querySelector('.line').append(result);
    if (message) row.querySelector('.what').append(make('code', 'msg', message));
  }

  function clearResults() {
    for (const row of [startRow, ...rec.rows]) {
      row.classList.remove('is-running');
      row.querySelector('.result')?.remove();
      row.querySelector('.msg')?.remove();
    }
  }

  /* The flow file */

  function renderYaml() {
    const text = toMaestroYaml({ appId: APP_ID, name: CASE_NAME, steps: rec.steps });
    const lines = text.slice(0, -1).split('\n');
    let first = null;
    const elements = lines.map((line, i) => {
      const element = yamlLine(line);
      if (!rec.quiet && line !== rec.yamlLines[i]) {
        element.classList.add('is-new');
        first ??= element;
      }
      return element;
    });
    ui.yaml.replaceChildren(...elements.flatMap((element) => [element, '\n']));
    rec.yamlLines = lines;
    rec.yamlText = text;
    if (first) {
      const delta = first.getBoundingClientRect().bottom - ui.yamlScroll.getBoundingClientRect().bottom;
      if (delta > 0) ui.yamlScroll.scrollBy({ top: delta + 24, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  }

  /* The bar above the screen and the foot of the panel */

  function renderBar() {
    const recording = rec.mode === 'recording';
    const running = rec.mode === 'running';
    ui.phone.classList.toggle('is-recording', recording);
    ui.phone.classList.toggle('is-checking', rec.check);
    if (recording || running) {
      ui.recState.replaceChildren(
        make('span', 'rec-dot'),
        make('strong', '', recording ? 'Recording' : 'Running'),
        make('span', 'rec-case', CASE_NAME),
        ...(recording ? [make('span', 'rec-count', stepCount(rec.steps.length))] : []),
      );
    } else {
      ui.recState.replaceChildren(make('span', 'rec-text', `Not recording · ${APP_ID}`));
    }
    ui.record.textContent = recording ? 'Finish recording' : 'Start recording';
    ui.record.disabled = running;
    ui.check.setAttribute('aria-pressed', String(rec.check));
    for (const field of app.fields) field.readOnly = !recording;
  }

  function renderFoot() {
    const hadFocus = ui.foot.contains(document.activeElement);
    const parts = [];
    if (rec.mode === 'idle') {
      parts.push(make('p', 'foot-hint', 'Press Start recording, then use the app on the phone. Every tap and every word you type becomes a step.'));
    } else if (rec.mode === 'recording') {
      parts.push(
        make(
          'div',
          'foot-actions',
          button('Finish recording', 'btn btn-primary btn-sm', finish),
          button('Discard', 'btn btn-danger btn-sm', discard),
        ),
      );
    } else {
      const running = rec.mode === 'running';
      const run = button('Run', 'btn btn-primary btn-sm', startRun);
      run.dataset.act = 'run';
      const again = button('Record again', 'btn btn-secondary btn-sm', (event) => {
        if (event.isTrusted && auto.on) return takeOver();
        startRecording();
      });
      run.disabled = again.disabled = running;
      const summary = make('p', 'run-summary');
      summary.dataset.summary = '';
      if (running) {
        summary.classList.add('is-busy');
        summary.textContent = 'Running';
      } else if (rec.results) {
        summary.classList.add(rec.results.pass ? 'is-pass' : 'is-fail');
        summary.textContent = rec.results.pass ? 'Last run passed' : `Failed at step ${rec.results.step}`;
      }
      parts.push(make('p', 'saved', icon('tick'), `Saved "${CASE_NAME}"`), make('div', 'foot-actions', run, again, summary));
    }
    ui.foot.replaceChildren(...parts);
    if (hadFocus) ui.foot.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  function renderControls() {
    ui.pause.hidden = !auto.on;
    ui.pause.textContent = auto.paused ? 'Play' : 'Pause';
    ui.yourself.hidden = !(auto.on || reducedMotion);
    ui.again.hidden = auto.on || reducedMotion;
  }

  function renderAll() {
    renderBar();
    renderFoot();
    renderYaml();
    renderCaption();
  }

  /* Recording */

  function syncValues() {
    for (const field of app.fields) lastValue.set(field, field.value);
  }

  function endSession() {
    const session = rec.session;
    if (!session) return;
    rec.session = null;
    if (session.timer) {
      clearTimeout(session.timer);
      announceStep(session.index);
    }
  }

  // An empty case: the app back at a fresh start and no steps.
  function resetCase(mode) {
    rec.session = null;
    rec.steps = [];
    for (const row of rec.rows) row.remove();
    rec.rows = [];
    rec.results = null;
    rec.check = false;
    clearResults();
    app.freshStart();
    syncValues();
    hover(null);
    rec.mode = mode;
    ui.scroll.scrollTop = 0;
    renderAll();
  }

  function startRecording() {
    resetCase('recording');
    say('Recording. Use the app on the phone.');
  }

  function finish() {
    if (rec.steps.length === 0) return hint('Use the app on the phone first. Every tap becomes a step.');
    endSession();
    rec.check = false;
    rec.mode = 'saved';
    hover(null);
    renderAll();
    say(`Saved "${CASE_NAME}"`);
  }

  function discard() {
    resetCase('idle');
    say('Recording discarded');
  }

  function setCheck(on) {
    rec.check = on;
    renderBar();
    renderCaption();
  }

  /** A tap on an element of the phone, from a visitor or from autoplay. */
  function activate(node, real) {
    if (rec.mode === 'running') return;
    if (rec.mode !== 'recording') return hintNotRecording();
    flash(node);
    const selector = selectorFor({ id: node.dataset.id, text: nodeName(node) });
    if (rec.check) {
      // A check records what is on the screen and leaves the app alone.
      endSession();
      captureThumb(addStep({ kind: 'check', selector, name: nodeName(node) }));
      setCheck(false);
      return;
    }
    // A tap on the field that already has focus changes nothing, so it is not a step.
    if (node.matches('[data-field]') && app.focused === node) return;
    endSession();
    const index = addStep({ kind: 'tap', selector, name: nodeName(node) });
    app.tap(node, { real });
    syncValues();
    captureThumb(index);
  }

  /** Text arrived in a field: one type step per stretch of typing in one field. */
  function typed(field) {
    const before = lastValue.get(field) ?? '';
    lastValue.set(field, field.value);
    if (rec.mode !== 'recording') return;
    if (app.focused !== field) app.focus(field);
    let session = rec.session;
    if (!session || session.field !== field) {
      endSession();
      session = rec.session = { field, initial: before, index: -1, timer: 0 };
    }
    const value = field.value;
    const text = value.startsWith(session.initial) ? value.slice(session.initial.length) : value;
    if (session.index < 0) {
      if (!text) return;
      session.index = addStep({ kind: 'type', text });
    } else if (!text) {
      removeLastStep();
      session.index = -1;
      clearTimeout(session.timer);
      session.timer = 0;
      return;
    } else {
      rec.steps[session.index].text = text;
      rec.rows[session.index].querySelector('.words').textContent = stepWords(rec.steps[session.index]).text;
      renderYaml();
    }
    captureThumb(session.index);
    if (!rec.quiet && !auto.running) {
      clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = 0;
        announceStep(session.index);
      }, 900);
    }
  }

  function pressKey(key, real) {
    if (rec.mode === 'running') return;
    if (rec.mode !== 'recording') return hintNotRecording();
    const keyButton = ui.keys.find((element) => element.dataset.key === key);
    if (!rec.quiet) {
      keyButton.classList.add('is-pressed');
      setTimeout(() => keyButton.classList.remove('is-pressed'), 220);
    }
    endSession();
    const index = addStep(key === 'Back' ? { kind: 'back' } : { kind: 'key', key });
    app.press(key, { real });
    syncValues();
    captureThumb(index);
  }

  /* Running */

  function startRun() {
    if (rec.mode !== 'saved') return;
    rec.run = runCase();
  }

  async function runCase() {
    const wait = waiter();
    const duration = durations();
    rec.mode = 'running';
    rec.results = null;
    clearResults();
    renderBar();
    renderFoot();
    const summary = () => ui.foot.querySelector('[data-summary]');
    try {
      app.freshStart();
      syncValues();
      hover(null);
      startRow.classList.add('is-running');
      follow(startRow);
      await wait(700);
      setResult(startRow, 'pass', duration('start'));
      let failed = -1;
      for (const [i, step] of rec.steps.entries()) {
        const row = rec.rows[i];
        row.classList.add('is-running');
        follow(row);
        summary().textContent = `Running step ${i + 1} of ${rec.steps.length}`;
        if (step.kind === 'tap' || step.kind === 'check') {
          const node = app.find((candidate) => matches(candidate, step.selector));
          if (!node) {
            await wait(900);
            setResult(row, 'fail', NOT_FOUND_MS, notFoundMessage(step.selector));
            failed = i;
            break;
          }
          await pointAt(node, wait);
          await press(wait);
          flash(node);
          if (step.kind === 'tap') app.tap(node);
        } else if (step.kind === 'type') {
          await wait(250);
          for (const char of step.text) {
            app.type(char);
            await wait(45);
          }
        } else {
          const key = step.kind === 'back' ? 'Back' : step.key;
          await pointAt(ui.keys.find((element) => element.dataset.key === key), wait);
          await press(wait);
          app.press(key);
        }
        syncValues();
        await wait(300);
        setResult(row, 'pass', duration(step.kind));
      }
      if (failed >= 0) for (const row of rec.rows.slice(failed + 1)) setResult(row, 'not-run');
      rec.results = failed < 0 ? { pass: true } : { pass: false, step: failed + 1 };
      hover(null);
      if (!auto.running) hidePointer();
      rec.mode = 'saved';
      renderBar();
      renderFoot();
      say(rec.results.pass ? 'Last run passed' : `Failed at step ${rec.results.step}`);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    }
  }

  /* Autoplay */

  function takeOver() {
    const zone = [ui.phone, ui.caseCol].find((element) => element.contains(document.activeElement));
    auto.on = false;
    auto.running = false;
    generation += 1;
    hidePointer();
    ui.callout.hidden = true;
    startRecording();
    renderControls();
    // The reset can take away the element that had keyboard focus; hand focus to a control that is still there.
    const active = document.activeElement;
    if (zone === ui.phone && !app.isShown(active)) app.fab().focus({ preventScroll: true });
    if (zone === ui.caseCol && !ui.caseCol.contains(active)) ui.caseCol.querySelector('button')?.focus({ preventScroll: true });
  }

  async function autoplay() {
    auto.running = true;
    renderControls();
    const wait = waiter();
    const tap = async (target, action) => {
      await pointAt(target, wait);
      await press(wait);
      action();
    };
    const type = async (field, text) => {
      for (const char of text) {
        field.value += char;
        typed(field);
        await wait(95 + Math.round(Math.random() * 60));
      }
    };
    try {
      for (;;) {
        resetCase('idle');
        await wait(1000);
        await tap(ui.record, () => ui.record.click());
        await wait(500);
        await tap(app.fab(), () => activate(app.fab(), false));
        await wait(600);
        await type(app.title, 'Dentist');
        await wait(350);
        await tap(app.location, () => activate(app.location, false));
        await wait(250);
        await type(app.location, 'Athens');
        await wait(400);
        await tap(app.save(), () => activate(app.save(), false));
        await wait(900);
        await tap(ui.check, () => ui.check.click());
        await wait(300);
        const event = app.firstEvent();
        await tap(event, () => activate(event, false));
        await wait(800);
        await tap(ui.record, () => ui.record.click());
        await wait(800);
        const run = ui.foot.querySelector('[data-act="run"]');
        await tap(run, () => run.click());
        await rec.run;
        hidePointer();
        await wait(5000);
        auto.cycles += 1;
        if (auto.cycles === 1) ui.callout.hidden = false;
      }
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    }
  }

  function startAutoplay() {
    if (!auto.on || auto.running || auto.paused || !auto.inView) return;
    generation += 1;
    autoplay();
  }

  /* The finished case, built through the same functions, replaces the page's static copy of it */

  function buildFinished() {
    rec.quiet = true;
    const type = (field, text) => {
      for (const char of text) {
        field.value += char;
        typed(field);
      }
    };
    startRecording();
    activate(app.fab(), false);
    type(app.title, 'Dentist');
    activate(app.location, false);
    type(app.location, 'Athens');
    activate(app.save(), false);
    setCheck(true);
    activate(app.firstEvent(), false);
    finish();
    const duration = durations();
    setResult(startRow, 'pass', duration('start'));
    rec.steps.forEach((step, i) => setResult(rec.rows[i], 'pass', duration(step.kind)));
    rec.results = { pass: true };
    renderFoot();
    app.hideSnack();
    hover(null);
    ui.scroll.scrollTop = 0;
    rec.quiet = false;
  }

  /* Wiring */

  // A visitor's own click or key press inside the phone or the panel ends autoplay for good. So does keyboard
  // focus arriving there, since the next autoplay reset would otherwise pull it away.
  const takeOverOnTouch = (event) => {
    if (auto.on && event.isTrusted) takeOver();
  };
  // A completed click, never a touch that turns into a scroll: on a phone the demo is taller than
  // the screen, and a thumb passing over it must not stop it.
  for (const zone of [ui.phone, ui.caseCol, ui.keysBar, ui.controls]) {
    zone.addEventListener('click', takeOverOnTouch, { capture: true });
    zone.addEventListener('keydown', takeOverOnTouch, { capture: true });
  }
  for (const zone of [ui.phone, ui.caseCol]) zone.addEventListener('focusin', takeOverOnTouch, { capture: true });

  const resolveNode = (target) => {
    const node = target.closest('[data-node]') ?? target.closest('button')?.querySelector('[data-node]');
    return node && ui.phone.contains(node) && app.isShown(node) ? node : null;
  };

  ui.phone.addEventListener('pointerover', (event) => {
    if (!auto.running) hover(resolveNode(event.target));
  });
  ui.phone.addEventListener('pointerleave', () => {
    if (!auto.running) hover(null);
  });
  ui.phone.addEventListener('pointerdown', (event) => {
    // A field must not take focus from a click that records a check, or from one that does nothing.
    const node = resolveNode(event.target);
    if (node?.matches('[data-field]') && (rec.mode !== 'recording' || rec.check)) event.preventDefault();
  });
  ui.phone.addEventListener('click', (event) => {
    const node = resolveNode(event.target);
    if (!node) {
      if (rec.mode === 'idle' || rec.mode === 'saved') hintNotRecording();
      return;
    }
    // A field counts its tap when it takes focus.
    if (node.matches('[data-field]') && rec.mode === 'recording' && !rec.check) return;
    activate(node, true);
  });
  ui.phone.addEventListener('focusin', (event) => {
    const field = event.target.closest('[data-field]');
    if (!field || auto.running || rec.mode !== 'recording' || rec.check || app.focused === field || !app.isShown(field)) return;
    activate(field, true);
  });
  ui.phone.addEventListener('input', (event) => {
    const field = event.target.closest('[data-field]');
    if (field) typed(field);
  });
  ui.phone.addEventListener('keydown', (event) => {
    // With Check on, Enter on a field checks it, as a click would.
    const field = event.target.closest('[data-field]');
    if (field && event.key === 'Enter' && rec.check) {
      event.preventDefault();
      activate(field, true);
    }
  });

  ui.record.addEventListener('click', (event) => {
    if (event.isTrusted && auto.on) return takeOver();
    if (rec.mode === 'recording') finish();
    else startRecording();
  });
  ui.check.addEventListener('click', () => {
    if (rec.mode !== 'recording') return hint('Start recording, then turn on Check');
    setCheck(!rec.check);
  });
  for (const key of ui.keysBar.querySelectorAll('.key')) {
    key.addEventListener('click', () => {
      if (key.dataset.key) pressKey(key.dataset.key, !auto.running);
      else hint(key.title);
    });
  }
  ui.copyYaml.addEventListener('click', () => copyText(rec.yamlText, ui.copyYaml));

  ui.pause.addEventListener('click', () => {
    auto.paused = !auto.paused;
    renderControls();
    if (!auto.paused) startAutoplay();
  });
  ui.yourself.addEventListener('click', takeOver);
  ui.again.addEventListener('click', () => {
    auto.on = true;
    auto.paused = false;
    auto.cycles = 0;
    ui.callout.hidden = true;
    renderControls();
    startAutoplay();
  });

  if ('IntersectionObserver' in window) {
    const steps = Array.from({ length: 21 }, (_, i) => i / 20);
    new IntersectionObserver(([entry]) => {
      // At least half of the windows, or half the screen when the windows are taller than it.
      const needed = Math.min(entry.boundingClientRect.height, innerHeight) * 0.5;
      auto.inView = entry.isIntersecting && entry.intersectionRect.height >= needed;
      startAutoplay();
    }, { threshold: steps }).observe(ui.windows);
  }

  buildFinished();
  renderControls();
}
