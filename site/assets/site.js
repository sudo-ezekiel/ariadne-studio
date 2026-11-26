// The landing page's behaviour: theme, header, menu, reveals, the page thread,
// tabs, copy buttons, videos and the init terminal. The hero's studio demo and
// the section demos have their own modules.
import { initStudioDemo } from './studio-demo.js';
import { initRecordDemos } from './record-demos.js';
import { initRunDemo } from './run-demo.js';
import { initBlocksDemo } from './blocks-demo.js';

const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pageStatus = document.querySelector('[data-page-status]');

/** Says something to screen readers without moving focus. */
function announce(text) {
  pageStatus.textContent = '';
  // A fresh text node after a tick, so the same message twice is read twice.
  setTimeout(() => (pageStatus.textContent = text), 30);
}

// The theme button. The choice is stored the way VitePress stores it, so the docs agree:
// picking the theme the system already has stores 'auto', and the page follows the system again.
function initTheme() {
  const KEY = 'vitepress-theme-appearance';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const toggle = document.querySelector('.theme-toggle');
  let choice = 'auto';
  try {
    choice = localStorage.getItem(KEY) || 'auto';
  } catch {}
  const apply = () => {
    const theme = choice === 'light' || choice === 'dark' ? choice : system.matches ? 'dark' : 'light';
    const changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    toggle.title = toggle.getAttribute('aria-label');
    if (changed) document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  };
  toggle.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    choice = next === (system.matches ? 'dark' : 'light') ? 'auto' : next;
    // With storage off (some private windows) the choice lasts until reload.
    try {
      localStorage.setItem(KEY, choice);
    } catch {}
    apply();
  });
  system.addEventListener('change', apply);
  // The docs open in the same browser, often in another tab.
  addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    choice = event.newValue || 'auto';
    apply();
  });
  apply();
  toggle.hidden = false;
}

// The header gets its background once the page moves; below 820px the links fold into a menu.
function initHeader() {
  const header = document.querySelector('[data-header]');
  const button = header.querySelector('.menu-btn');
  const panel = header.querySelector('.menu-panel');
  const onScroll = () => header.classList.toggle('is-scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  button.hidden = false;
  const setOpen = (open, { returnFocus = false } = {}) => {
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) panel.querySelector('a').focus();
    else if (returnFocus) button.focus();
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false, { returnFocus: true });
  });
  addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !header.contains(event.target)) setOpen(false);
  });
  matchMedia('(min-width: 821px)').addEventListener('change', (event) => {
    if (event.matches) setOpen(false);
  });
}

// Sections and cards rise into place once, the first time they are seen.
function initReveals() {
  const items = [...document.querySelectorAll('.reveal')];
  // Cards in one grid follow each other by a beat.
  for (const item of items) {
    const siblings = [...item.parentElement.children].filter((child) => child.classList.contains('reveal'));
    if (siblings.length > 1) item.style.setProperty('--reveal-delay', `${siblings.indexOf(item) * 80}ms`);
  }
  if (!('IntersectionObserver' in window)) {
    for (const item of items) item.classList.add('is-in');
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  for (const item of items) observer.observe(item);
}

// The page thread: the fill reaches a ring as its section reaches the reading line.
function initRail() {
  const rail = document.querySelector('[data-rail]');
  const links = [...rail.querySelectorAll('a')];
  const sections = links.map((link) => document.querySelector(link.hash));
  const wide = matchMedia('(min-width: 1280px)');
  let queued = false;

  const update = () => {
    queued = false;
    if (!wide.matches) return;
    const line = scrollY + innerHeight * 0.35;
    const tops = sections.map((section) => section.getBoundingClientRect().top + scrollY);
    let current = 0;
    tops.forEach((top, i) => {
      if (top <= line) current = i;
    });
    let progress = current;
    const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    if (atEnd) {
      current = sections.length - 1;
      progress = current;
    } else if (current < sections.length - 1) {
      const span = tops[current + 1] - tops[current];
      progress += Math.min(1, Math.max(0, (line - tops[current]) / span));
    }
    rail.style.setProperty('--fill', `${(progress / (sections.length - 1)) * 100}%`);
    links.forEach((link, i) => {
      link.classList.toggle('is-passed', i <= current);
      link.classList.toggle('is-current', i === current);
      if (i === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  wide.addEventListener('change', queue);
  update();
}

// Tabs with arrow keys, Home and End. Selecting a tab shows its panel at once.
function initTabs() {
  for (const container of document.querySelectorAll('[data-tabs]')) {
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const select = (tab, { focus = false } = {}) => {
      for (const other of tabs) {
        const selected = other === tab;
        other.setAttribute('aria-selected', String(selected));
        other.tabIndex = selected ? 0 : -1;
        document.getElementById(other.getAttribute('aria-controls')).classList.toggle('is-active', selected);
      }
      if (focus) tab.focus();
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
      container.dispatchEvent(new CustomEvent('tabchange'));
    };
    for (const tab of tabs) {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (event) => {
        const i = tabs.indexOf(tab);
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length], { focus: true });
      });
    }
    // The footage frame takes the height of the open panel, so each picture shows whole at its
    // own shape. The tab row above it stays where it is.
    const frame = container.querySelector('.viewer-panels');
    if (frame && 'ResizeObserver' in window) {
      const fit = () => (frame.style.height = `${frame.querySelector('.is-active').offsetHeight}px`);
      const observer = new ResizeObserver(fit);
      for (const panel of frame.children) observer.observe(panel);
      container.addEventListener('tabchange', fit);
    }
  }
}

/** Copies text and shows "Copied" on the button for a moment. */
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API needs a secure page; fall back to a selection.
    const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  button.classList.add('is-copied');
  announce('Copied');
  clearTimeout(button.copiedTimer);
  button.copiedTimer = setTimeout(() => button.classList.remove('is-copied'), 1500);
}

function initCopy() {
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  }
}

// The footage videos play while their tab is open and in view, never with reduced motion.
// The recording has a light and a dark version; the poster and the file follow the theme.
// The page's <source> elements are for readers without scripts. Here the script sets the
// file only when a video is about to play, so nothing is downloaded before that. The posters
// wait until the section is about a screen away, and the recording's is only this theme's.
function initVideos() {
  const videos = [...document.querySelectorAll('[data-video]')];
  for (const video of videos) {
    video.removeAttribute('controls');
    const toggle = video.parentElement.querySelector('.video-toggle');
    const panel = video.closest('[role="tabpanel"]');
    const state = { paused: false, inView: false };
    const format = video.canPlayType('video/webm') ? 'webm' : 'mp4';
    const themed = video.dataset.video === 'record';
    const file = () => `media/${video.dataset.video}${themed && root.dataset.theme === 'dark' ? '-dark' : ''}.${format}`;
    for (const source of video.querySelectorAll('source')) source.remove();
    video.load();

    const sync = () => {
      const play = !reducedMotion && !state.paused && state.inView && panel.classList.contains('is-active');
      if (play && video.getAttribute('src') !== file()) video.src = file();
      if (play && video.paused) video.play().catch(() => {});
      if (!play && !video.paused) video.pause();
    };

    let near = false;
    const setPoster = () => (video.poster = `media/${video.dataset.video}-poster${themed && root.dataset.theme === 'dark' ? '-dark' : ''}.webp`);
    const showPoster = () => {
      near = true;
      setPoster();
    };
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        showPoster();
      }, { rootMargin: '100% 0px' });
      observer.observe(video.closest('section'));
    } else showPoster();

    if (themed) {
      document.addEventListener('themechange', () => {
        if (near) setPoster();
        // A video that has the other theme's file drops it; sync loads this theme's if it should be playing.
        if (video.hasAttribute('src') && video.getAttribute('src') !== file()) {
          video.removeAttribute('src');
          video.load();
        }
        sync();
      });
    }

    if (reducedMotion) continue;
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      state.paused = !state.paused;
      toggle.textContent = state.paused ? 'Play' : 'Pause';
      sync();
    });
    new IntersectionObserver(([entry]) => {
      state.inView = entry.isIntersecting;
      sync();
    }, { threshold: 0.4 }).observe(video);
    panel.closest('[data-tabs]').addEventListener('tabchange', sync);
  }
}

// The init terminal types itself once, the first time it is seen, and again on "Run it again".
// Its full text is in the page.
function initTerminal() {
  const body = document.querySelector('[data-typed]');
  if (!body || reducedMotion || !('IntersectionObserver' in window)) return;
  const command = body.querySelector('.t-cmd');
  const output = body.querySelector('.t-out');
  const prompt = command.querySelector('.t-prompt').outerHTML;
  const commandText = command.textContent.replace(/^\$ /, '');
  const lines = output.textContent.split('\n');
  const again = Object.assign(document.createElement('button'), { type: 'button', className: 'terminal-again', textContent: 'Run it again' });
  body.closest('.terminal').querySelector('.terminal-bar').append(again);
  let typing = 0;

  const type = async () => {
    const run = ++typing;
    const delay = (ms) => new Promise((resolve, reject) => setTimeout(() => (run === typing ? resolve() : reject()), ms));
    body.style.minHeight = `${body.offsetHeight}px`;
    const caret = '<span class="t-caret"></span>';
    output.textContent = '';
    try {
      for (let i = 0; i <= commandText.length; i++) {
        command.innerHTML = prompt + commandText.slice(0, i).replace(/</g, '&lt;') + caret;
        await delay(i === 0 ? 300 : 42);
      }
      await delay(350);
      command.innerHTML = prompt + commandText;
      for (let i = 0; i < lines.length; i++) {
        output.textContent = lines.slice(0, i + 1).join('\n');
        await delay(lines[i] ? 70 : 30);
      }
    } catch {
      // A newer run took over.
    }
  };
  again.addEventListener('click', type);
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    type();
  }, { threshold: 0.5 });
  observer.observe(body);
}

initTheme();
initHeader();
initReveals();
initRail();
initTabs();
initCopy();
initVideos();
initTerminal();
// The run demo's phone is a copy of the hero's, taken before the hero demo starts changing it.
const agendaDevice = document.querySelector('[data-studio-demo] [data-phone] .device').cloneNode(true);
initRunDemo(document.querySelector('[data-demo="run"]'), agendaDevice, { reducedMotion, announce });
initRecordDemos({ reducedMotion });
initBlocksDemo(document.querySelector('[data-demo="blocks"]'), { reducedMotion });
initStudioDemo(document.querySelector('[data-studio-demo]'), { reducedMotion, copyText });
