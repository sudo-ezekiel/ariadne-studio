// Projects, card 1: a setup block on the thread before recording. Add puts
// Log in under "Before recording" (so does dragging it there), and the phone
// runs it with the chosen test user. Remove takes it off again.
import { createSignInAgenda } from './agenda.js';
import { addHint, appendRow, createPointer, make, playOnceOnView, sleeper, toButton, upgrade } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';

function puzzle() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#i-puzzle');
  svg.append(use);
  return svg;
}

export function initBlocksDemo(stage, { reducedMotion }) {
  if (!stage) return;
  const list = stage.querySelector('.steps-mini');
  const item = stage.querySelector('.block-item');
  const add = toButton(item.querySelector('.mini-btn'), 'Add Log in to Before recording');
  add.textContent = 'Add';
  list.querySelector('.is-block').remove();
  const drop = make('p', 'drop-line', 'Drag a setup block here to run it first, such as a log in, or press Add on one below.');
  list.after(drop);
  const phone = createSignInAgenda(stage.querySelector('.phone-mini'));
  addHint(stage, 'Press Add, or drag Log in under Before recording');
  upgrade(stage);

  let row = null;
  let select = null;
  let runs = 0;

  // Each run of the block replaces the one before it.
  async function runBlock(user) {
    const run = ++runs;
    try {
      await phone.signIn(user, reducedMotion ? () => Promise.resolve() : sleeper(() => run === runs));
    } catch {
      // A newer run, or Remove, took over.
    }
  }

  function blockRow() {
    select = make('select', '', ...['Default', 'Supervisor'].map((name) => Object.assign(document.createElement('option'), { value: name, textContent: name })));
    select.value = 'Supervisor';
    select.addEventListener('change', () => runBlock(select.value));
    const remove = make('button', 'mini-btn row-remove', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove the Log in block');
    remove.addEventListener('click', removeBlock);
    const what = make(
      'span',
      'what',
      make('span', 'line', make('span', 'words', 'Log in'), remove),
      make('span', 'test-user', make('label', '', 'Test user ', select)),
    );
    return make('li', 'step is-block', make('span', 'mark mark-block', puzzle()), make('span', 'kind', 'block'), what);
  }

  function addBlock({ quiet = false } = {}) {
    if (row) return;
    row = blockRow();
    if (quiet) list.append(row);
    else appendRow(list, row, { reducedMotion });
    drop.hidden = true;
    add.textContent = 'Added';
    add.disabled = true;
    if (quiet) phone.showHome('Supervisor');
    else runBlock(select.value);
  }

  function removeBlock() {
    const hadFocus = row.contains(document.activeElement);
    runs += 1;
    row.remove();
    row = null;
    drop.hidden = false;
    add.textContent = 'Add';
    add.disabled = false;
    phone.showLogin();
    if (hadFocus) add.focus();
  }

  add.addEventListener('click', () => addBlock());

  // Dragging the block onto the drop line does what Add does. A touch that moves the page
  // scrolls it instead: the browser cancels the drag, and Add is still there.
  let drag = null;
  const overDrop = (event) => {
    const box = drop.getBoundingClientRect();
    return event.clientX >= box.left - 16 && event.clientX <= box.right + 16 && event.clientY >= box.top - 16 && event.clientY <= box.bottom + 16;
  };
  const endDrag = (event, dropped) => {
    if (drag?.id !== event.pointerId) return;
    const over = dropped && drag.ghost && overDrop(event);
    drag.ghost?.remove();
    drag = null;
    item.classList.remove('is-dragging');
    drop.classList.remove('is-over');
    if (over) addBlock();
  };
  item.addEventListener('pointerdown', (event) => {
    if (row || event.button !== 0 || event.target.closest('button')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ghost: null };
    item.setPointerCapture(event.pointerId);
  });
  item.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    if (!drag.ghost) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.ghost = make('div', 'block-ghost', make('span', 'block-mark', puzzle()), 'Log in');
      drag.ghost.setAttribute('aria-hidden', 'true');
      document.body.append(drag.ghost);
      item.classList.add('is-dragging');
    }
    drag.ghost.style.transform = `translate(${event.clientX - 20}px, ${event.clientY - 16}px)`;
    drop.classList.toggle('is-over', overDrop(event));
  });
  item.addEventListener('pointerup', (event) => endDrag(event, true));
  item.addEventListener('pointercancel', (event) => endDrag(event, false));

  // With reduced motion the stage keeps the finished picture: the block added, signed in as Supervisor.
  if (reducedMotion) addBlock({ quiet: true });
  else phone.showLogin();

  const pointer = createPointer(stage);
  playOnceOnView(
    stage,
    async (wait) => {
      await wait(500);
      await pointer.at(add, wait);
      await pointer.press(wait);
      add.click();
      await wait(300);
    },
    { reducedMotion, pointer },
  );
}
