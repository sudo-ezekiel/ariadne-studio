// Drives the real studio for the site's stills and videos: a headless Chromium
// (the Playwright shell in ~/.cache/ms-playwright) over the DevTools protocol,
// and ffmpeg for the videos. A dot stands in for the pointer, which a headless
// page does not draw. No dependencies beyond those two programs.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  const root = join(homedir(), '.cache/ms-playwright');
  const shell = readdirSync(root).filter((name) => name.startsWith('chromium_headless_shell-')).sort().pop();
  if (!shell) throw new Error(`No Chromium headless shell in ${root}. Run: npx playwright install chromium-headless-shell`);
  return join(root, shell, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

const CURSOR_SCRIPT = `
(() => {
  if (window.__cursor) return;
  const dot = document.createElement('div');
  dot.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
    'background:rgba(232,180,58,.45);border:2px solid #e8b43a;box-shadow:0 1px 4px rgba(15,22,39,.35);' +
    'pointer-events:none;z-index:2147483647;transition:transform .12s ease;opacity:0';
  const attach = () => document.documentElement.appendChild(dot);
  document.documentElement ? attach() : addEventListener('DOMContentLoaded', attach);
  window.__cursor = {
    move(x, y) { dot.style.left = x + 'px'; dot.style.top = y + 'px'; dot.style.opacity = '1'; },
    press(on) { dot.style.transform = on ? 'scale(.7)' : 'scale(1)'; },
    hide() { dot.style.opacity = '0'; },
  };
})();`;

export class Page {
  static async open({ width = 1480, height = 1000, dark = false, port = 9341 } = {}) {
    const profile = mkdtempSync(join(tmpdir(), 'ariadne-capture-'));
    const chrome = spawn(chromePath(), [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      await delay(100);
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((item) => item.type === 'page');
      } catch {
        // Not listening yet.
      }
    }
    if (!target) throw new Error('Chromium did not start.');
    const page = new Page(chrome, profile, new WebSocket(target.webSocketDebuggerUrl));
    await new Promise((resolve) => (page.ws.onopen = resolve));
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_SCRIPT });
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    return page;
  }

  constructor(chrome, profile, ws) {
    this.chrome = chrome;
    this.profile = profile;
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.pointer = { x: 700, y: 500 };
    this.frames = null;
    this.ranges = [];
    ws.onmessage = (event) => this.onMessage(JSON.parse(event.data));
  }

  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      this.pending.get(message.id)(message);
      this.pending.delete(message.id);
    }
    if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = message.params;
      void this.send('Page.screencastFrameAck', { sessionId });
      if (this.frames) this.frames.push({ data, at: metadata.timestamp });
    }
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails)}`);
    return response.result?.result?.value;
  }

  async goto(url, settleMs = 900) {
    await this.send('Page.navigate', { url });
    await delay(settleMs);
    await this.send('Runtime.evaluate', { expression: CURSOR_SCRIPT });
  }

  async waitFor(expression, { timeoutMs = 30_000, what = expression } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await delay(150);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /** Waits for the top bar to stop saying the studio is busy. */
  waitIdle(timeoutMs = 120_000) {
    return this.waitFor(`!document.querySelector('.status-busy')`, { timeoutMs, what: 'the studio to finish' });
  }

  /** A JS expression for the first element matching a CSS selector and, optionally, containing text. */
  static find(selector, text) {
    const list = `[...document.querySelectorAll(${JSON.stringify(selector)})]`;
    return text === undefined ? `${list}[0]` : `${list}.find((el) => el.textContent.includes(${JSON.stringify(text)}))`;
  }

  async box(selector, text) {
    const rect = await this.evaluate(`(() => { const el = ${Page.find(selector, text)}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (!rect) throw new Error(`Nothing matches ${selector}${text === undefined ? '' : ` with "${text}"`}`);
    return rect;
  }

  async moveTo(x, y, durationMs = 450) {
    const from = this.pointer;
    const steps = Math.max(1, Math.round(durationMs / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t * t * (3 - 2 * t);
      const at = { x: from.x + (x - from.x) * eased, y: from.y + (y - from.y) * eased };
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, pointerType: 'mouse' });
      await this.send('Runtime.evaluate', { expression: `window.__cursor?.move(${at.x}, ${at.y})` });
      await delay(16);
    }
    this.pointer = { x, y };
  }

  async clickAt(x, y, { moveMs = 450, holdMs = 60 } = {}) {
    await this.moveTo(x, y, moveMs);
    await this.send('Runtime.evaluate', { expression: 'window.__cursor?.press(true)' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await delay(holdMs);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await this.send('Runtime.evaluate', { expression: 'window.__cursor?.press(false)' });
  }

  async click(selector, text, options) {
    const box = await this.box(selector, text);
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2, options);
  }

  /** Types into whatever has focus, one character at a time, as a person would. */
  async type(text, perCharMs = 55) {
    for (const char of text) {
      await this.send('Input.insertText', { text: char });
      await delay(perCharMs);
    }
  }

  async fill(selector, text, options) {
    await this.click(selector, undefined, options);
    await this.type(text);
  }

  hideCursor() {
    return this.send('Runtime.evaluate', { expression: 'window.__cursor?.hide()' });
  }

  async shot(file) {
    mkdirSync(dirname(file), { recursive: true });
    await this.hideCursor();
    await delay(120);
    const response = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(response.result.data, 'base64'));
    console.log(`  still ${file}`);
  }

  /**
   * Runs `task` and shortens that stretch of the video to `targetMs`. For waits
   * on the device, which would otherwise be most of a demo; the site says so.
   */
  async compressed(task, targetMs = 280) {
    const from = Date.now() / 1000;
    const result = await task();
    const to = Date.now() / 1000;
    if (this.frames) this.ranges.push({ from, to, factor: Math.min(1, targetMs / 1000 / Math.max(to - from, 0.001)) });
    return result;
  }

  /** Waits out a click on the mirror: the action, then the new screen loading. */
  async settle() {
    await this.compressed(async () => {
      await delay(120);
      await this.waitIdle();
      await delay(350);
    });
  }

  async startVideo() {
    this.frames = [];
    this.ranges = [];
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  }

  /** Writes <base>.mp4 and <base>.webm at `width`, each frame held until the next one. */
  async stopVideo(base, { width = 1280, holdLastMs = 1500 } = {}) {
    await this.send('Page.stopScreencast');
    const frames = this.frames;
    this.frames = null;
    if (frames.length < 2) throw new Error('The video has no frames.');
    const dir = mkdtempSync(join(tmpdir(), 'ariadne-frames-'));
    const list = [];
    frames.forEach((frame, i) => {
      const name = `f${String(i).padStart(6, '0')}.jpg`;
      writeFileSync(join(dir, name), Buffer.from(frame.data, 'base64'));
      const next = frames[i + 1];
      let seconds = next ? next.at - frame.at : holdLastMs / 1000;
      if (next) {
        for (const range of this.ranges) {
          const overlap = Math.min(next.at, range.to) - Math.max(frame.at, range.from);
          if (overlap > 0) seconds -= overlap * (1 - range.factor);
        }
      }
      list.push(`file '${name}'`, `duration ${Math.max(0.001, seconds).toFixed(4)}`);
    });
    list.push(`file 'f${String(frames.length - 1).padStart(6, '0')}.jpg'`);
    writeFileSync(join(dir, 'frames.txt'), `${list.join('\n')}\n`);
    mkdirSync(dirname(base), { recursive: true });
    const input = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-vf', `fps=30,scale=${width}:-2:flags=lanczos`, '-an'];
    run('ffmpeg', [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`]);
    run('ffmpeg', [...input, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', `${base}.webm`]);
    rmSync(dir, { recursive: true, force: true });
    console.log(`  video ${base}.mp4 and .webm, ${frames.length} frames`);
  }

  async close() {
    this.ws.close();
    this.chrome.kill();
    await delay(200);
    rmSync(this.profile, { recursive: true, force: true });
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`${command} failed`);
}

/** The studio's HTTP API, for arranging a scene without showing every click. */
export class Studio {
  constructor(base) {
    this.base = base;
  }

  async api(method, path, body) {
    const response = await fetch(this.base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  screen() {
    return this.api('GET', '/api/screen');
  }

  /** The node whose label or id contains `text`; `last` for the deepest match. */
  async node(text, { exact = false } = {}) {
    const { nodes } = await this.screen();
    const matches = (value) => typeof value === 'string' && (exact ? value === text : value.includes(text));
    const found = nodes.filter((node) => (matches(node.label) || matches(node.identifier) || matches(node.contentDescription)) && node.rect);
    if (found.length === 0) {
      const labels = nodes.map((node) => node.label).filter(Boolean).slice(0, 40).join(' | ');
      throw new Error(`No node with "${text}". On screen: ${labels}`);
    }
    return found[found.length - 1];
  }

  /** Taps through the API; recorded like a click when a case is open. */
  async tap(text, options) {
    const { rect } = await this.node(text, options);
    return this.api('POST', '/api/action/tap', { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
  }
}

/** Page coordinates of a device point in the mirror, for a real click on it. */
export async function mirrorPoint(page, screen, point) {
  const box = await page.box('.screen img');
  return { x: box.x + (point.x / screen.width) * box.width, y: box.y + (point.y / screen.height) * box.height };
}

/** Clicks the mirror on the node with `text`, as a person would. */
export async function clickNode(page, studio, text, options) {
  const screen = await studio.screen();
  const { rect } = await studio.node(text, options);
  const at = await mirrorPoint(page, screen, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  await page.clickAt(at.x, at.y);
}

export { delay };
