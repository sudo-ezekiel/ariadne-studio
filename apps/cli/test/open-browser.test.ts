import { describe, expect, it } from 'vitest';
import { browserCommand } from '../src/open-browser.ts';

const url = 'http://127.0.0.1:4711';

describe('browserCommand', () => {
  it('uses open on macOS', () => {
    expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
  });

  it('uses cmd /c start with an empty window title and a quoted, verbatim URL on Windows', () => {
    expect(browserCommand(url, 'win32')).toEqual({ command: 'cmd', args: ['/c', 'start', '""', `"${url}"`], verbatim: true });
  });

  it('quotes a URL with an ampersand on Windows so cmd does not split it', () => {
    const { args } = browserCommand('http://x/?a=1&b=2', 'win32');
    expect(args.at(-1)).toBe('"http://x/?a=1&b=2"');
  });

  it.each(['linux', 'freebsd', 'openbsd'] as const)('uses xdg-open on %s', (platform) => {
    expect(browserCommand(url, platform)).toEqual({ command: 'xdg-open', args: [url] });
  });
});
