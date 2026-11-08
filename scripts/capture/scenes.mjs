// Records the site's footage on real apps with the real studio.
//   node scripts/capture/scenes.mjs calendar|blocks|existing
// With CAPTURE_THEME=dark it records the studio's dark theme instead, for the
// landing page's dark mode: only the footage that page shows, under -dark names.
// The docs and the other stills stay light.
// Needs an emulator (CAPTURE_DEVICE, default emulator-5560) with Fossify
// Calendar and the WebdriverIO demo app installed, and a built UI (pnpm build).
// Everything shown is really happening; only waits on the device are shortened.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page, Studio, clickNode, delay } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = join(ROOT, 'site');
const DEVICE = process.env.CAPTURE_DEVICE ?? 'emulator-5560';
const PORT = 4801;
const BASE = `http://127.0.0.1:${PORT}`;
const CALENDAR = 'org.fossify.calendar';
const WDIO = 'com.wdiodemoapp';

const DARK = process.env.CAPTURE_THEME === 'dark';
const THEME = DARK ? 'dark' : 'light';
/** A site path, with -dark before its extension in a dark capture. */
const themed = (path) => (DARK ? path.replace(/(\.\w+)?$/, '-dark$1') : path);

const adb = (...args) => execFileSync('adb', ['-s', DEVICE, ...args], { encoding: 'utf8' });
const step = (message) => console.log(`- ${message}`);

async function startStudio(projectDir) {
  const child = spawn('pnpm', ['exec', 'tsx', 'src/server/main.ts'], {
    cwd: join(ROOT, 'apps/studio'),
    env: { ...process.env, ARIADNE_PROJECT_DIR: projectDir, ARIADNE_SESSION_NAME: 'capture', PORT: String(PORT) },
    stdio: 'ignore',
    detached: true,
  });
  const studio = new Studio(BASE);
  for (let i = 0; i < 100; i++) {
    await delay(300);
    try {
      await studio.api('GET', '/api/project');
      return {
        studio,
        stop: async () => {
          await studio.api('POST', '/api/session/close').catch(() => undefined);
          process.kill(-child.pid);
          await delay(500);
        },
      };
    } catch {
      // Still starting.
    }
  }
  throw new Error('The studio did not start.');
}

function freshProject(dir, appId, files = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ appId, platform: 'android', lastDeviceId: DEVICE }, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

async function openStudio(page, { files = false, theme = 'light' } = {}) {
  await page.goto(BASE);
  await page.evaluate(`(() => {
    localStorage.setItem('ariadne-theme', ${JSON.stringify(theme)});
    ${files ? `localStorage.removeItem('ariadne-files')` : `localStorage.setItem('ariadne-files', 'closed')`};
  })()`);
  await page.goto(BASE, 1400);
  await page.waitFor(`document.querySelector('.topbar')`);
}

const startCase = async (studio, appId) => studio.api('POST', '/api/session/open', { deviceId: DEVICE, appId });

async function tapMirror(page, studio, text, options) {
  await clickNode(page, studio, text, options);
  await page.settle();
}

async function typeOnDevice(page, text) {
  await page.fill('.mirror-controls input', text);
  await delay(150);
  await page.click('.mirror-controls button[type=submit]');
  await page.settle();
}

async function startRecording(page, name) {
  await page.fill('.composer input', name);
  await delay(200);
  await page.click('.record-button');
  await page.settle();
  await page.waitFor(`document.querySelector('.rec')`, { what: 'the recording to start', timeoutMs: 120_000 });
}

async function finishRecording(page, { pickerShot } = {}) {
  await page.click('.case-actions button.primary', 'Finish recording');
  await page.compressed(() => page.waitFor(`document.querySelector('.picker')`, { what: 'the end checks' }));
  await delay(500);
  if (pickerShot) await page.shot(pickerShot);
  await page.click('.picker button.primary', 'Save case');
  await page.settle();
  await page.waitFor(`document.querySelector('.finished')`, { what: 'the case to save' });
}

const clickNow = (page, selector, text) => page.evaluate(`(${Page.find(selector, text)}).click()`);

async function openCase(page, name) {
  await clickNow(page, '.panel-tabs button', 'Cases');
  await delay(300);
  await page.evaluate(`[...document.querySelectorAll('.saved-cases li')].find((li) => li.textContent.includes(${JSON.stringify(name)})).querySelector('.saved-actions button').click()`);
  await page.waitFor(`document.querySelector('.run-summary')`, { what: `the case ${name}` });
  await delay(400);
}

async function runOpenCase(page) {
  await clickNow(page, '.case-actions button.primary', 'Run');
  await delay(300);
  await page.waitIdle(280_000);
  await delay(800);
}

async function caseId(studio, name) {
  const project = await studio.api('GET', '/api/project');
  return project.cases.find((item) => item.name === name).id;
}

function grant(appId, permissions) {
  for (const permission of permissions) {
    try {
      adb('shell', 'pm', 'grant', appId, `android.permission.${permission}`);
    } catch {
      // Not every permission applies on every Android version.
    }
  }
}

/** The run video exactly as the studio saved it, in the two formats the page offers. */
function saveRunVideo(video) {
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  copyFileSync(video, join(SITE, 'media/run.mp4'));
  ffmpeg('-i', video, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-an', join(SITE, 'media/run.webm'));
  ffmpeg('-sseof', '-14', '-i', video, '-frames:v', '1', join(SITE, 'media/run-poster.png'));
}

function lastFrame(video, target) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-sseof', '-1', '-i', video, '-frames:v', '1', '-update', '1', target]);
}

/** Fossify opens on the month view; the event list is the view with text a check can read. */
async function prepareCalendar(studio) {
  adb('shell', 'pm', 'clear', CALENDAR);
  grant(CALENDAR, ['POST_NOTIFICATIONS', 'READ_CALENDAR', 'WRITE_CALENDAR']);
  await startCase(studio, CALENDAR);
  await studio.tap('change_view');
  await delay(600);
  await studio.tap('Simple event list');
  await delay(800);
  // The first saved event brings up a one-time reminders notice. Get it out of the way, and leave the list empty.
  await studio.tap('calendar_fab');
  await delay(600);
  await studio.tap('fab_event_label');
  await delay(1000);
  await studio.api('POST', '/api/action/type', { text: 'First run' });
  await delay(400);
  await studio.tap('save');
  await delay(1000);
  await studio.tap('button1');
  await delay(1800);
  const { rect } = await studio.node('event_item_title');
  await studio.api('POST', '/api/action/long-press', { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
  await delay(700);
  await studio.tap('cab_delete');
  await delay(700);
  await studio.tap('button1');
  await delay(1000);
}

async function calendar() {
  const project = '/tmp/calendar-tests';
  freshProject(project, CALENDAR);
  const { studio, stop } = await startStudio(project);
  const page = await Page.open();
  try {
    step('preparing the app');
    await prepareCalendar(studio);
    await openStudio(page, { theme: THEME });

    step('the hero: recording Create an event');
    await page.startVideo();
    await delay(900);
    await startRecording(page, 'Create an event');
    await tapMirror(page, studio, 'calendar_fab');
    await tapMirror(page, studio, 'fab_event_label');
    await typeOnDevice(page, 'Dentist');
    await tapMirror(page, studio, 'event_location');
    await typeOnDevice(page, 'Athens');
    await tapMirror(page, studio, 'save');
    await page.click('.mirror-controls button', 'Check');
    await delay(300);
    await tapMirror(page, studio, 'Dentist', { exact: true });
    await finishRecording(page);
    await page.click('.yaml-box summary');
    await delay(3200);
    await page.stopVideo(join(SITE, themed('media/record')));
    await page.shot(join(SITE, themed('media/record-poster.png')));
    // The run video and the stills below look the same in either theme, or are only in the docs.
    if (DARK) return;

    step('a run with its video');
    // From a clean list, so the run ends on the one event it made.
    await startCase(studio, CALENDAR);
    await prepareCalendar(studio);
    await studio.api('PUT', '/api/project/run-video', { on: true });
    await page.goto(BASE, 1400);
    await openCase(page, 'Create an event');
    await runOpenCase(page);
    const firstId = await caseId(studio, 'Create an event');
    const detail = await studio.api('GET', `/api/cases/${firstId}`);
    console.log(`  last run passed: ${detail.runs[0]?.passed}, video: ${detail.runs[0]?.video}`);
    await page.goto(BASE, 1400);
    await openCase(page, 'Create an event');
    await page.shot(join(SITE, 'img/run-passed.png'));
    saveRunVideo(join(project, detail.runs[0].video));
    await studio.api('PUT', '/api/project/run-video', { on: false });
    console.log(readFileSync(join(project, `flows/${firstId}.yaml`), 'utf8'));

    step('recording, mid-way');
    await page.goto(BASE, 1400);
    await startRecording(page, 'Open the Dentist event');
    const dentist = (await studio.node('Dentist', { exact: true })).rect;
    const at = { x: Math.round(dentist.x + dentist.width / 2), y: Math.round(dentist.y + dentist.height / 2) };
    await studio.api('POST', '/api/action/long-press', at);
    await delay(500);
    await studio.api('POST', '/api/action/back');
    await delay(500);
    await page.goto(BASE, 1200);
    await tapMirror(page, studio, 'Dentist', { exact: true });
    await page.click('.mirror-controls button', 'Check');
    await delay(300);
    await tapMirror(page, studio, 'event_title');
    await page.moveTo(1000, 760, 200);
    await page.goto(BASE, 1400);
    await page.shot(join(SITE, 'img/studio-recording.png'));
    await finishRecording(page);

    step('a case that starts from another');
    await studio.api('POST', '/api/action/back').catch(() => undefined);
    await page.goto(BASE, 1400);
    await page.evaluate(`(() => {
      const select = document.querySelector('.piece-start-label select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(firstId)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await delay(300);
    await startRecording(page, 'Rename the event');
    await tapMirror(page, studio, 'Dentist', { exact: true });
    await tapMirror(page, studio, 'event_title');
    await typeOnDevice(page, ' check-up');
    await tapMirror(page, studio, 'save');
    await finishRecording(page);

    step('a pass, then a real failure');
    await studio.api('PUT', '/api/project/run-video', { on: true });
    await page.goto(BASE, 1400);
    await openCase(page, 'Open the Dentist event');
    await runOpenCase(page);
    await startCase(studio, CALENDAR);
    await prepareCalendar(studio);
    await page.goto(BASE, 1400);
    await openCase(page, 'Open the Dentist event');
    await runOpenCase(page);
    await page.shot(join(SITE, 'img/run-failed.png'));
    const failedId = await caseId(studio, 'Open the Dentist event');
    const failed = await studio.api('GET', `/api/cases/${failedId}`);
    console.log(`  last run passed: ${failed.runs[0]?.passed}`);
    lastFrame(join(project, failed.runs[0].video), join(SITE, 'img/run-video-failed.png'));
    await studio.api('PUT', '/api/project/run-video', { on: false });

    step('report and document');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(BASE + failed.runs[0].reportUrl, 900);
    await page.shot(join(SITE, 'img/run-report.png'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1000, deviceScaleFactor: 1, mobile: false });
    await fetch(`${BASE}/api/cases/${firstId}/export?format=html`);
    await page.goto(`file://${project}/exports/${firstId}.html`, 900);
    await page.shot(join(SITE, 'img/test-case-document.png'));

    step('cases, chained');
    await page.goto(BASE, 1400);
    await clickNow(page, '.panel-tabs button', 'Cases');
    await delay(500);
    await page.shot(join(SITE, 'img/chained-cases.png'));

    step('dark, Files open');
    await openStudio(page, { files: true, theme: 'dark' });
    await openCase(page, 'Create an event');
    await clickNow(page, '.files-row', 'flows');
    await delay(400);
    await clickNow(page, '.files-row', firstId);
    await delay(500);
    await page.shot(join(SITE, 'img/studio-dark-files.png'));

    step('settings and device setup');
    await studio.api('PUT', '/api/project/run-video', { on: true });
    await openStudio(page);
    await clickNow(page, 'button[aria-label="Settings"]');
    await delay(300);
    await page.shot(join(SITE, 'img/settings-run-video.png'));
    await clickNow(page, '.menu-item', 'Device setup');
    await delay(1800);
    await page.shot(join(SITE, 'img/device-setup.png'));
    await studio.api('PUT', '/api/project/run-video', { on: false });
    console.log(`console errors: ${JSON.stringify(page.errors)}`);
  } finally {
    await page.close();
    await stop();
  }
}

const LOGIN_BLOCK = `appId: ${WDIO}
name: Log in
---
- launchApp
- tapOn:
    text: "Login"
    index: 0
- tapOn:
    text: "Email"
- inputText: "\${USERNAME}"
- tapOn:
    text: "Password"
- inputText: "\${PASSWORD}"
- hideKeyboard
- tapOn:
    point: "50%,62%"
- assertVisible:
    text: "You are logged in!"
- tapOn:
    text: "OK"
`;

const POPUP_BLOCK = `appId: ${WDIO}
name: Dismiss the popup
---
- tapOn:
    text: "OK"
`;

async function blocks() {
  const project = '/tmp/wdio-tests';
  freshProject(project, WDIO, {
    'blocks/login.yaml': LOGIN_BLOCK,
    'blocks/dismiss-popup.yaml': POPUP_BLOCK,
    '.env': 'USERNAME=ba@example.com\nPASSWORD=Sunflower-42\nSUPERVISOR_USERNAME=supervisor@example.com\nSUPERVISOR_PASSWORD=Sunflower-43\n',
  });
  const { studio, stop } = await startStudio(project);
  const page = await Page.open();
  try {
    adb('shell', 'pm', 'clear', WDIO);
    await startCase(studio, WDIO);
    await openStudio(page, { theme: THEME });

    step('block under Before recording, with a test user');
    await page.fill('.composer input', 'Submit the form');
    await page.evaluate(`[...document.querySelectorAll('.palette .piece')].find((el) => el.textContent.includes('Log in')).querySelector('.piece-add').click()`);
    await delay(500);
    await page.evaluate(`(() => {
      const select = document.querySelector('.block-settings select');
      const option = [...select.options].find((item) => item.textContent.includes('Supervisor'));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await delay(500);
    await page.moveTo(1000, 960, 150);
    if (!DARK) await page.shot(join(SITE, 'img/blocks-before-recording.png'));

    step('recording from the block');
    await page.click('.record-button');
    await page.settle();
    await page.waitFor(`document.querySelector('.rec')`, { what: 'the recording to start', timeoutMs: 120_000 });
    await delay(1500);
    await tapMirror(page, studio, 'Forms', { exact: true });
    await tapMirror(page, studio, 'button-Active');

    step('a block in the middle of the recording');
    await page.evaluate(`document.querySelector('details.run-blocks').open = true`);
    await delay(400);
    await page.evaluate(`[...document.querySelectorAll('.run-blocks .piece')].find((el) => el.textContent.includes('Dismiss the popup')).querySelector('.piece-add').click()`);
    await delay(300);
    await page.settle();
    await delay(600);
    await page.evaluate(`document.querySelector('details.run-blocks').open = false`);
    await delay(300);
    await page.moveTo(1000, 960, 150);
    await page.shot(join(SITE, themed('img/block-mid-recording.png')));
    await finishRecording(page);
    console.log(`console errors: ${JSON.stringify(page.errors)}`);
    console.log(readdirSync(join(project, 'flows')).map((name) => readFileSync(join(project, 'flows', name), 'utf8')).join('\n'));
  } finally {
    await page.close();
    await stop();
  }
}

/** A repository with a Maestro workspace, adopted with `ariadne-studio init`. */
async function existing() {
  const repo = '/tmp/wdio-app';
  freshProject(repo, WDIO);
  rmSync(join(repo, 'project.json'));
  for (const [name, text] of Object.entries({
    '.maestro/config.yaml': 'flows:\n  - "*.yaml"\n  - recorded/*\n',
    '.maestro/smoke.yaml': `appId: ${WDIO}\nname: Smoke\n---\n- launchApp\n- assertVisible:\n    text: "WEBDRIVER"\n`,
    '.maestro/subflows/login.yaml': LOGIN_BLOCK,
    '.maestro/subflows/dismiss-popup.yaml': POPUP_BLOCK,
  })) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  console.log(execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', repo], { cwd: join(ROOT, 'apps/cli'), encoding: 'utf8' }));
  const project = join(repo, '.ariadne');
  writeFileSync(join(project, '.env'), 'USERNAME=ba@example.com\nPASSWORD=Sunflower-42\n');
  const { studio, stop } = await startStudio(project);
  const page = await Page.open();
  try {
    adb('shell', 'pm', 'clear', WDIO);
    await startCase(studio, WDIO);
    await openStudio(page, { files: true, theme: THEME });

    step('record from a team subflow');
    await page.fill('.composer input', 'Open the forms');
    await page.evaluate(`[...document.querySelectorAll('.palette .piece')].find((el) => el.textContent.includes('Log in')).querySelector('.piece-add').click()`);
    await delay(400);
    await page.click('.record-button');
    await page.settle();
    await page.waitFor(`document.querySelector('.rec')`, { what: 'the recording to start', timeoutMs: 120_000 });
    await delay(1500);
    await tapMirror(page, studio, 'Forms', { exact: true });
    await finishRecording(page, { pickerShot: DARK ? undefined : join(SITE, 'img/end-checks.png') });

    step('run it with Maestro');
    const id = await caseId(studio, 'Open the forms');
    await page.goto(BASE, 1400);
    await openCase(page, 'Open the forms');
    await runOpenCase(page);
    console.log(`  last run passed: ${(await studio.api('GET', `/api/cases/${id}`)).runs[0]?.passed}`);

    step('the Files column on the workspace');
    await clickNow(page, '.files-row', '../.maestro/recorded');
    await delay(400);
    await clickNow(page, '.files-row', '../.maestro/subflows');
    await delay(400);
    await clickNow(page, '.files-row', id);
    await delay(500);
    await page.shot(join(SITE, themed('img/existing-project.png')));
    console.log(`console errors: ${JSON.stringify(page.errors)}`);
  } finally {
    await page.close();
    await stop();
  }
}

const ANKI = 'com.ichi2.anki';

/** A setup block on a real app with no login: AnkiDroid's first-run screen. */
async function anki() {
  const project = '/tmp/anki-tests';
  freshProject(project, ANKI, {
    'blocks/skip-first-run.yaml': `appId: ${ANKI}\nname: Skip first run\n---\n- launchApp:\n    clearState: true\n- tapOn:\n    text: "Get started"\n- assertVisible:\n    text: "AnkiDroid"\n`,
  });
  const { studio, stop } = await startStudio(project);
  const page = await Page.open();
  try {
    adb('shell', 'pm', 'clear', ANKI);
    // Android's all-files access is a Settings page, so grant it up front.
    adb('shell', 'appops', 'set', ANKI, 'MANAGE_EXTERNAL_STORAGE', 'allow');
    await startCase(studio, ANKI);
    await openStudio(page);

    step('record from the block');
    await page.fill('.composer input', 'Add a card');
    await page.evaluate(`document.querySelector('.palette .piece .piece-add').click()`);
    await delay(400);
    await page.click('.record-button');
    await page.settle();
    await page.waitFor(`document.querySelector('.rec')`, { what: 'the recording to start', timeoutMs: 120_000 });
    await delay(1500);
    await tapMirror(page, studio, 'fab_main');
    await delay(800);
    console.log((await studio.screen()).nodes.map((node) => node.label ?? node.contentDescription).filter(Boolean).slice(0, 30).join(' | '));
    await page.moveTo(1000, 960, 150);
    await page.shot(join(SITE, 'img/block-real-app.png'));
    await finishRecording(page);

    step('run it with Maestro');
    const id = await caseId(studio, 'Add a card');
    await page.goto(BASE, 1400);
    await openCase(page, 'Add a card');
    await runOpenCase(page);
    console.log(`  last run passed: ${(await studio.api('GET', `/api/cases/${id}`)).runs[0]?.passed}`);
    console.log(readFileSync(join(project, `flows/${id}.yaml`), 'utf8'));
    console.log(`console errors: ${JSON.stringify(page.errors)}`);
  } finally {
    await page.close();
    await stop();
  }
}

const scenes = { calendar, blocks, existing, anki };
const name = process.argv[2];
if (!scenes[name]) {
  console.error(`Usage: node scripts/capture/scenes.mjs ${Object.keys(scenes).join('|')}`);
  process.exit(2);
}
await scenes[name]();
