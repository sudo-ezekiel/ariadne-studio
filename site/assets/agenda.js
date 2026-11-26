// Agenda, the made-up calendar app (com.example.agenda) on the demo phone.
// It is built from the phone markup in index.html and knows how its screens
// answer a tap or a phone button. It knows nothing about recording.

/** What an element shows, as a step names it: its label, else its text. */
export function nodeName(node) {
  return node.dataset.name ?? node.textContent.trim();
}

export function createAgenda(phone) {
  const device = phone.querySelector('.device');
  const screens = Object.fromEntries([...phone.querySelectorAll('[data-screen]')].map((screen) => [screen.dataset.screen, screen]));
  const list = phone.querySelector('[data-events]');
  const snack = phone.querySelector('[data-snack]');
  const title = phone.querySelector('[data-id="event_title"]');
  const location = phone.querySelector('[data-id="event_location"]');
  const allDay = phone.querySelector('[data-id="all_day"]');
  const fields = [title, location];
  let screen = 'home';
  let resume = 'home';
  let events = [];
  let focused = null;
  let snackTimer = 0;

  function renderEvents() {
    list.replaceChildren(
      ...events.map((event) => {
        const item = document.createElement('li');
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'ag-event' });
        const time = Object.assign(document.createElement('span'), { className: 'ag-time', textContent: event.time });
        const name = Object.assign(document.createElement('span'), { className: 'ag-event-title', textContent: event.title });
        Object.assign(name.dataset, { node: '', id: 'event_item_title', role: 'text' });
        button.append(time, name);
        item.append(button);
        return item;
      }),
    );
  }

  function setFocus(field, real) {
    focused?.classList.remove('is-focused');
    focused = field;
    field?.classList.add('is-focused');
    if (real && field) field.focus({ preventScroll: true });
    else if (!field && fields.includes(document.activeElement)) document.activeElement.blur();
  }

  // `real` is true when a visitor did this: keyboard focus then follows to the new screen.
  function show(name, real) {
    const hadFocus = phone.contains(document.activeElement);
    screen = name;
    for (const [key, element] of Object.entries(screens)) element.hidden = key !== name;
    setFocus(null);
    if (real && hadFocus) screens[name].querySelector('button, input')?.focus({ preventScroll: true });
  }

  function hideSnack() {
    clearTimeout(snackTimer);
    snack.hidden = true;
    screens.home.classList.remove('has-snack');
  }

  function showSnack() {
    hideSnack();
    snack.hidden = false;
    screens.home.classList.add('has-snack');
    snackTimer = setTimeout(hideSnack, 3200);
  }

  function openNewEvent(real) {
    for (const field of fields) field.value = '';
    allDay.setAttribute('aria-checked', 'false');
    show('new', real);
    // The form opens with the title field focused, as Android apps do.
    setFocus(title, real);
  }

  return {
    fields,
    get screen() {
      return screen;
    },
    get focused() {
      return focused;
    },
    fab: () => phone.querySelector('[data-id="fab_new_event"]'),
    title,
    location,
    save: () => phone.querySelector('[data-id="save"]'),
    firstEvent: () => list.querySelector('[data-node]'),

    isShown(node) {
      return screens[screen].contains(node);
    },

    /** The first element on the screen that `test` accepts. */
    find(test) {
      return [...screens[screen].querySelectorAll('[data-node]')].find(test) ?? null;
    },

    /** A clean start: the app's data cleared, on its home screen. */
    freshStart() {
      events = [{ title: 'Team standup', time: '09:00' }];
      renderEvents();
      for (const field of fields) field.value = '';
      allDay.setAttribute('aria-checked', 'false');
      hideSnack();
      resume = 'home';
      show('home', false);
    },

    tap(node, { real = false } = {}) {
      switch (node.dataset.id ?? node.dataset.name) {
        case 'fab_new_event':
          openNewEvent(real);
          break;
        case 'back':
          show('home', real);
          break;
        case 'save':
          events.unshift({ title: title.value.trim() || 'Untitled', time: '08:00' });
          events = events.slice(0, 4);
          renderEvents();
          show('home', real);
          showSnack();
          break;
        case 'event_title':
        case 'event_location':
          setFocus(node, real);
          break;
        case 'all_day':
          node.setAttribute('aria-checked', String(node.getAttribute('aria-checked') !== 'true'));
          break;
        case 'Agenda':
          show(resume, real);
          break;
        default:
          // Event rows and the reminder row have nothing more to open here.
          break;
      }
    },

    /** A phone button, by its Maestro key name. */
    press(key, { real = false } = {}) {
      if (key === 'Back') {
        if (screen === 'new') show('home', real);
        else if (screen === 'home') {
          resume = 'home';
          show('launcher', real);
        }
      } else if (key === 'Home' && screen !== 'launcher') {
        resume = screen;
        show('launcher', real);
      }
    },

    /** Moves the app's focus to a field, as a tap on it would, without the page's focus moving. */
    focus(field) {
      setFocus(field, false);
    },

    /** Types into the focused field, as Maestro's inputText does. */
    type(text) {
      if (focused) focused.value += text;
    },

    hideSnack,

    /** A copy of the screen as it is now, for a step's thumbnail. */
    snapshot() {
      const copy = device.cloneNode(true);
      const live = device.querySelectorAll('input');
      copy.querySelectorAll('input').forEach((input, i) => input.setAttribute('value', live[i].value));
      for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');
      for (const node of copy.querySelectorAll('.is-hover, .is-tap')) node.classList.remove('is-hover', 'is-tap');
      for (const node of copy.querySelectorAll('[data-node]')) {
        delete node.dataset.node;
        delete node.dataset.field;
      }
      return copy;
    },
  };
}

/** The test users a Log in block can run with, and what each one sees. */
export const TEST_USERS = {
  Default: { username: 'clerk@example.com', password: 'clerk-2026', requests: 0 },
  Supervisor: { username: 'supervisor@example.com', password: 'super-2026', requests: 2 },
};

/**
 * Agenda behind its sign-in screen, for the setup block demo. The phone's
 * Home screen is in the page; the sign-in screen is added here.
 */
export function createSignInAgenda(phone) {
  const device = phone.querySelector('.device');
  const home = device.querySelector('.ag-home');
  const signed = home.querySelector('.ag-signed');
  const events = home.querySelector('.ag-events');
  const field = (label) => {
    const value = Object.assign(document.createElement('span'), { className: 'ag-field-value' });
    const box = Object.assign(document.createElement('span'), { className: 'ag-field' });
    box.append(Object.assign(document.createElement('span'), { className: 'ag-field-label', textContent: label }), value);
    return { box, value };
  };
  const username = field('Username');
  const password = field('Password');
  const submit = Object.assign(document.createElement('span'), { className: 'ag-login-btn', textContent: 'Log in' });
  const login = Object.assign(document.createElement('div'), { className: 'ag-screen ag-login' });
  login.append(
    Object.assign(document.createElement('p'), { className: 'ag-login-title', textContent: 'Agenda' }),
    Object.assign(document.createElement('p'), { className: 'ag-login-sub', textContent: 'Sign in to see your calendar' }),
    username.box,
    password.box,
    submit,
  );
  home.before(login);

  const showLogin = () => {
    username.value.textContent = '';
    password.value.textContent = '';
    login.hidden = false;
    home.hidden = true;
  };

  const showHome = (user) => {
    const { username: name, requests } = TEST_USERS[user];
    signed.textContent = `Signed in as ${name}`;
    events.querySelector('.ag-request')?.remove();
    if (requests) {
      const row = Object.assign(document.createElement('li'), { className: 'ag-request' });
      row.append(Object.assign(document.createElement('span'), { className: 'ag-event', textContent: `${requests} requests to approve` }));
      events.prepend(row);
    }
    login.hidden = true;
    home.hidden = false;
  };

  return {
    showLogin,
    showHome,
    submit,
    /** The Log in block: type the user name, then the password, then tap Log in. */
    async signIn(user, wait) {
      const { username: name, password: secret } = TEST_USERS[user];
      showLogin();
      await wait(250);
      for (const char of name) {
        username.value.textContent += char;
        await wait(32);
      }
      await wait(150);
      for (let i = 0; i < secret.length; i++) {
        password.value.textContent += '•';
        await wait(40);
      }
      await wait(200);
      submit.classList.remove('is-tap');
      void submit.offsetWidth;
      submit.classList.add('is-tap');
      await wait(350);
      showHome(user);
    },
  };
}
