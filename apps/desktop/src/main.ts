// Ariadne Studio desktop: one window around the studio server. The server is
// the ariadne-studio CLI bundle, run as a child process by Electron's own
// binary in Node mode, so the npm package and the app run the same code.
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { initialProjectDir, projectDirIn, readSettings, writeSettings } from './settings.ts';
import { ServerStartError, startServer, type StudioServer } from './server-process.ts';
import { studioPath } from './shell-path.ts';

const PRODUCT = 'Ariadne Studio';
/** Warm paper from docs/brand.md, so the window does not flash white before the UI paints. */
const PAPER = '#f4f3ee';

// Before anything reads userData, so dev runs and the packaged app share settings and logs.
app.setName(PRODUCT);
// The id electron-builder gives the Windows Start menu shortcut, so the taskbar groups the window under it.
if (process.platform === 'win32') app.setAppUserModelId('io.github.sudo-ezekiel.ariadne-studio');

const settingsFile = () => join(app.getPath('userData'), 'settings.json');
const logsDir = () => join(app.getPath('userData'), 'logs');

/** electron-builder copies the CLI bundle and agent-device to resources/server; in development it is apps/cli/dist. */
function serverEntry(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'server', 'dist', 'cli.mjs')
    : join(app.getAppPath(), '..', 'cli', 'dist', 'cli.mjs');
}

let mainWindow: BrowserWindow | undefined;
let server: StudioServer | undefined;
let serverEnv: NodeJS.ProcessEnv | undefined;
let quitting = false;

/** The project folder for the title bar: ~/... on Linux and macOS, the full path on Windows, which has no ~. */
function displayPath(path: string): string {
  const home = homedir();
  if (process.platform === 'win32') return path;
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function isStudioUrl(url: string): boolean {
  if (!server) return false;
  try {
    return new URL(url).origin === new URL(server.url).origin;
  } catch {
    return false;
  }
}

function openOutside(url: string): void {
  if (/^https?:/i.test(url)) void shell.openExternal(url);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: PAPER,
    title: PRODUCT,
    icon: join(app.getAppPath(), 'build-resources', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // The title names the project folder; the page's own <title> would replace it.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = undefined;
  });
  return window;
}

async function pickProjectDir(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Open project folder',
    message: 'Choose a folder for your cases, or a project folder a developer shared with you.',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory'],
    ...(server ? { defaultPath: server.projectDir } : {}),
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const picked = result.canceled ? undefined : result.filePaths[0];
  return picked ? projectDirIn(picked) : undefined;
}

async function chooseAndOpenProject(): Promise<void> {
  const dir = await pickProjectDir();
  if (dir && dir !== server?.projectDir) await openProject(dir);
}

async function openProject(projectDir: string): Promise<void> {
  const previous = server;
  server = undefined;
  await previous?.stop();
  try {
    serverEnv ??= { ...process.env, PATH: studioPath(), ELECTRON_RUN_AS_NODE: '1' };
    server = await startServer({
      entry: serverEntry(),
      projectDir,
      execPath: process.execPath,
      env: serverEnv,
      logFile: join(logsDir(), 'studio.log'),
      echo: !app.isPackaged,
    });
  } catch (error) {
    await startFailed(projectDir, error);
    return;
  }
  const running = server;
  writeSettings(settingsFile(), { projectDir: running.projectDir });
  running.onUnexpectedExit((code) => void serverStopped(running.projectDir, code));
  mainWindow ??= createWindow();
  mainWindow.setTitle(`${PRODUCT} · ${displayPath(running.projectDir)}`);
  await mainWindow.loadURL(running.url);
}

async function startFailed(projectDir: string, error: unknown): Promise<void> {
  const detail =
    error instanceof ServerStartError
      ? `${error.message}${error.output ? `\n\n${error.output}` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: PRODUCT,
    message: `Ariadne Studio could not open ${displayPath(projectDir)}`,
    detail: `${detail}\n\nThe full log is in ${displayPath(logsDir())}.`,
    buttons: ['Try again', 'Choose another folder…', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) return openProject(projectDir);
  if (response === 1) {
    const dir = await pickProjectDir();
    return dir ? openProject(dir) : startFailed(projectDir, error);
  }
  app.quit();
}

async function serverStopped(projectDir: string, code: number | null): Promise<void> {
  if (quitting) return;
  server = undefined;
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: PRODUCT,
    message: 'The studio server stopped unexpectedly.',
    detail: `Exit code ${code ?? 'unknown'}. The log is in ${displayPath(logsDir())}.`,
    buttons: ['Restart', 'Show logs', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) void shell.openPath(logsDir());
  if (response === 2) return app.quit();
  await openProject(projectDir);
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open project folder…', accelerator: 'CmdOrCtrl+O', click: () => void chooseAndOpenProject() },
        { label: 'Show project folder', click: () => server && void shell.openPath(server.projectDir) },
        { label: 'Open in browser', click: () => server && void shell.openExternal(server.url) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Show logs', click: () => void shell.openPath(logsDir()) },
        ...(isMac ? [] : [{ role: 'about' as const }]),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// Studio pages (reports, screenshots) open in an app window; anything else goes to the browser.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isStudioUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: PAPER, width: 1200, height: 860 } };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isStudioUrl(url)) return;
    event.preventDefault();
    openOutside(url);
  });
});

app.on('window-all-closed', () => app.quit());

// Close the device session before exiting so the phone is not left claimed.
app.on('before-quit', (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  const running = server;
  server = undefined;
  void running.stop().finally(() => app.quit());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: PRODUCT, applicationVersion: app.getVersion() });
    // The studio needs no camera, microphone, notifications or location.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    Menu.setApplicationMenu(buildMenu());
    await openProject(initialProjectDir(readSettings(settingsFile()), app.getPath('documents')));
  });
}
