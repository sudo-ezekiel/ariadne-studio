import { win32 } from 'node:path';

// Starting a .bat or .cmd file on Windows. Node refuses to spawn one without a
// shell (CVE-2024-27980), and cmd.exe parses the command line it is given, so
// every argument is quoted and escaped for cmd.exe here. A run's arguments
// carry .env values: an unescaped & or " in one would start a command of its own.
// The rules follow https://qntm.org/cmd, as cross-spawn does.

export type SpawnCommand = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

/** Characters cmd.exe gives a meaning to; a caret in front makes one literal. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument quoted the way Windows programs split their command line:
 * backslashes are literal except before a quote, so those are doubled and
 * the quote is escaped.
 */
export function quoteWindowsArgument(arg: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** Escapes every cmd.exe metacharacter once per time cmd.exe will parse the text. */
function escapeForCmd(text: string, parses: number): string {
  let escaped = text;
  for (let i = 0; i < parses; i += 1) escaped = escaped.replace(CMD_META, '^$1');
  return escaped;
}

/**
 * How to start `file` with `args`. A program starts directly. On Windows a
 * .bat or .cmd runs as `cmd.exe /d /s /v:off /c ""<file>" <args>"` with the
 * line passed verbatim. The file is quoted, which also covers spaces in the
 * path (a Windows path cannot contain a quote). The arguments are escaped for
 * two parses: the one of that line, and the one of the line inside the batch
 * file that hands `%*` on (Maestro's maestro.bat passes `%*` to java, as npm's
 * .cmd shims pass it to node).
 */
export function spawnCommand(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform, comspec = process.env.ComSpec): SpawnCommand {
  if (platform !== 'win32' || !/\.(bat|cmd)$/i.test(file)) return { command: file, args: [...args] };
  if (args.some((arg) => /[\r\n]/.test(arg))) throw new Error('An argument for a .bat or .cmd file cannot contain a line break.');
  const line = [`"${win32.normalize(file)}"`, ...args.map((arg) => escapeForCmd(quoteWindowsArgument(arg), 2))].join(' ');
  return { command: comspec || 'cmd.exe', args: ['/d', '/s', '/v:off', '/c', `"${line}"`], windowsVerbatimArguments: true };
}
