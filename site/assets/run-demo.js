// The Run band: the case's steps and the Agenda phone run together, step by
// step, with the pointer dot. The switch takes the Save button out of the app,
// so the run fails where Maestro would, with Maestro's message.
import { notFoundMessage, selectorFor } from './flow.js';
import { createAgenda } from './agenda.js';
import { createPointer, icon, make, playOnceOnView, sleeper } from './ui.js';

// The case, as its rows read: the start, then the six recorded steps.
const STEPS = [
  { kind: 'start' },
  { kind: 'tap', id: 'fab_new_event' },
  { kind: 'type', text: 'Dentist' },
  { kind: 'tap', id: 'event_location' },
  { kind: 'type', text: 'Athens' },
  { kind: 'tap', id: 'save' },
  { kind: 'check', id: 'event_item_title' },
];
const PASSED = 'Passed in 14.2 s';
const NOT_FOUND = '17.1 s';

export function initRunDemo(panel, device, { reducedMotion, announce }) {
  if (!panel) return;
  const play = panel.querySelector('[data-run-play]');
  const toggle = panel.querySelector('[data-run-break]');
  const state = panel.querySelector('[data-run-state]');
  const rows = [...panel.querySelectorAll('[data-run-steps] li')];
  const body = panel.querySelector('.run-body');
  const times = rows.map((row) => row.querySelector('.run-dur').textContent);

  // The phone becomes a working copy of the hero's Agenda, on the saved Home screen it already shows.
  const phone = panel.querySelector('.run-phone .phone');
  for (const node of device.querySelectorAll('.is-hover, .is-focused')) node.classList.remove('is-hover', 'is-focused');
  phone.querySelector('.device').replaceWith(device);
  // It only shows what the run does; nothing on it takes a click or focus.
  phone.inert = true;
  const app = createAgenda(phone);
  const save = app.save();
  const saveSpot = { parent: save.parentElement, next: save.nextSibling };
  const pointer = createPointer(body);

  panel.querySelector('.run-controls').after(make('p', 'run-hint', 'Turn the switch on and run it again to see a failure'));

  let running = false;
  const wait = sleeper(() => true);
  const speed = (ms) => (reducedMotion ? Math.min(ms, 60) : ms);

  function setRow(row, status, text) {
    row.className = `is-${status}`;
    row.querySelector('.run-msg')?.remove();
    const box = row.querySelector('.box');
    box.replaceChildren(icon(status === 'fail' ? 'cross' : 'tick'));
    if (text !== undefined) row.querySelector('.run-dur').textContent = text;
  }

  function setState(status, text) {
    state.className = `run-state is-${status}`;
    state.textContent = text;
  }

  function placeSave() {
    if (toggle.checked) save.remove();
    else if (!save.isConnected) saveSpot.parent.insertBefore(save, saveSpot.next);
  }

  function waiting() {
    rows.forEach((row, i) => setRow(row, 'pending', times[i]));
    setState('idle', 'Not run yet');
  }

  const flash = (node) => {
    node.classList.remove('is-tap');
    void node.offsetWidth;
    node.classList.add('is-tap');
  };

  async function run() {
    if (running) return;
    running = play.disabled = toggle.disabled = true;
    app.freshStart();
    placeSave();
    rows.forEach((row, i) => setRow(row, 'pending', times[i]));
    let failed = -1;
    for (const [i, step] of STEPS.entries()) {
      const row = rows[i];
      setRow(row, 'running');
      setState('busy', `Step ${i + 1} of ${STEPS.length}`);
      if (step.kind === 'start') await wait(speed(700));
      else if (step.kind === 'type') {
        await wait(speed(250));
        for (const char of step.text) {
          app.type(char);
          await wait(speed(70));
        }
      } else {
        const selector = selectorFor({ id: step.id });
        const node = app.find((candidate) => candidate.dataset.id === step.id);
        if (!node) {
          // Maestro looks for the element until its timeout, then fails the step.
          await wait(speed(2500));
          setRow(row, 'fail', NOT_FOUND);
          row.querySelector('.run-text').append(make('code', 'run-msg', notFoundMessage(selector)));
          failed = i;
          break;
        }
        await pointer.at(node, wait, { travelMs: speed(520) });
        await pointer.press(wait);
        flash(node);
        if (step.kind === 'tap') app.tap(node);
      }
      await wait(speed(300));
      setRow(row, 'pass');
    }
    pointer.hide();
    if (failed >= 0) {
      for (const row of rows.slice(failed + 1)) setRow(row, 'not-run', 'not run');
      setState('fail', `Failed at step ${failed + 1}`);
    } else {
      setState('pass', PASSED);
    }
    announce(state.textContent);
    running = play.disabled = toggle.disabled = false;
  }

  play.addEventListener('click', run);
  toggle.addEventListener('change', () => {
    if (running) return;
    app.freshStart();
    placeSave();
    waiting();
  });

  playOnceOnView(
    panel,
    async (playWait) => {
      await playWait(500);
      await pointer.at(play, playWait);
      await pointer.press(playWait);
      play.click();
    },
    { reducedMotion, pointer },
  );
}
