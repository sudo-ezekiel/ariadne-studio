import { spawn } from 'node:child_process';

export type BrowserCommand = { command: string; args: string[]; verbatim?: boolean };

export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd builtin; its first quoted argument is the window title.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', `"${url}"`], verbatim: true };
  return { command: 'xdg-open', args: [url] };
}

/** Best effort: the URL is printed anyway, so a missing opener is not an error. */
export function openBrowser(url: string): void {
  const { command, args, verbatim } = browserCommand(url, process.platform);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim ?? false });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Nothing to do; the caller has printed the address.
  }
}
