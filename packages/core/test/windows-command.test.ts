// Starting Maestro on Windows: quoting for CommandLineToArgvW, escaping for
// cmd.exe, where the CLI is looked for, and the environment it runs with.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maestroCandidates, toolsDir, toolsJavaHome } from '../src/replay/maestro-bin.ts';
import { maestroEnv, pathForMaestro } from '../src/replay/maestro-run.ts';
import { quoteWindowsArgument, spawnCommand } from '../src/replay/windows-command.ts';

/** CommandLineToArgvW rules for the arguments after the program name. */
function parseWindowsArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === '\\') {
      let n = 0;
      while (line[i] === '\\') {
        n += 1;
        i += 1;
      }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(n / 2));
        started = true;
        if (n % 2 === 1) {
          current += '"';
          i += 1;
        }
        // an even count leaves the quote to be handled as a toggle next round
      } else {
        current += '\\'.repeat(n);
        started = true;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
    i += 1;
  }
  if (started) args.push(current);
  return args;
}

/** One cmd.exe parse outside quotes: a caret makes the next character literal. */
const removeCarets = (text: string): string => text.replace(/\^(.)/g, '$1');

const META = new Set([...'()[]%!^"`<>&|;, *?']);

const NASTY = [
  'plain',
  '',
  'with space',
  'a"b',
  'a\\b',
  'a\\"b',
  'a\\\\"b',
  'a\\\\\\"b',
  'trailing\\',
  'trailing\\\\',
  'C:\\dir\\',
  '"',
  '""',
  '\\"',
  '"quoted"',
  'a&b',
  'a|b',
  'a"b&c',
  '<>^%!',
  '100%',
  '%PATH%',
  '!x!',
  '^caret',
  '(paren)',
  'semi;comma,star*what?',
  'back`tick',
  'Ρυθμίσεις',
];

describe('quoteWindowsArgument', () => {
  it.each([
    ['abc', '"abc"'],
    ['', '""'],
    ['a b', '"a b"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\b"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['a\\', '"a\\\\"'],
    ['C:\\dir\\', '"C:\\dir\\\\"'],
    ['Ρυθμίσεις', '"Ρυθμίσεις"'],
  ])('quotes %j as %j', (input, expected) => {
    expect(quoteWindowsArgument(input)).toBe(expected);
  });

  it('round-trips through the CommandLineToArgvW rules', () => {
    for (const value of NASTY) expect(parseWindowsArgs(quoteWindowsArgument(value)), JSON.stringify(value)).toEqual([value]);
  });

  it('round-trips a whole list of arguments joined by spaces', () => {
    expect(parseWindowsArgs(NASTY.map(quoteWindowsArgument).join(' '))).toEqual(NASTY);
  });
});

describe('spawnCommand', () => {
  const batch = 'C:\\Users\\John Smith\\maestro\\bin\\maestro.bat';

  it('returns a linux command unchanged, with a copy of the args', () => {
    const args = ['test', 'a&b'];
    const result = spawnCommand('/home/u/.maestro/bin/maestro', args, 'linux');
    expect(result).toEqual({ command: '/home/u/.maestro/bin/maestro', args: ['test', 'a&b'] });
    expect(result.args).not.toBe(args);
    expect(result).not.toHaveProperty('windowsVerbatimArguments');
  });

  it('does not wrap a .bat file outside Windows', () => {
    expect(spawnCommand('maestro.bat', ['x'], 'linux', 'cmd.exe')).toEqual({ command: 'maestro.bat', args: ['x'] });
  });

  it('starts a .exe directly on Windows', () => {
    const result = spawnCommand('C:\\sdk\\adb.exe', ['devices'], 'win32', 'cmd.exe');
    expect(result).toEqual({ command: 'C:\\sdk\\adb.exe', args: ['devices'] });
    expect(result).not.toHaveProperty('windowsVerbatimArguments');
  });

  it('does not treat a name that merely contains .bat as a batch file', () => {
    expect(spawnCommand('C:\\x\\maestro.bat.exe', [], 'win32', 'cmd.exe').command).toBe('C:\\x\\maestro.bat.exe');
  });

  it('wraps a .bat file in cmd.exe with the exact escaped line', () => {
    const result = spawnCommand(batch, ['test', 'A=b&c'], 'win32', 'C:\\Windows\\System32\\cmd.exe');
    expect(result).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/v:off',
        '/c',
        '""C:\\Users\\John Smith\\maestro\\bin\\maestro.bat" ^^^"test^^^" ^^^"A=b^^^&c^^^""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it('wraps a .cmd file and escapes percent signs and carets twice in arguments', () => {
    const result = spawnCommand('C:\\tools\\run.cmd', ['100%', '^'], 'win32', 'cmd.exe');
    expect(result.args[4]).toBe('""C:\\tools\\run.cmd" ^^^"100^^^%^^^" ^^^"^^^^^^^""');
  });

  it('wraps an upper case .BAT file', () => {
    const result = spawnCommand('C:\\tools\\RUN.BAT', ['x'], 'win32', 'cmd.exe');
    expect(result.command).toBe('cmd.exe');
    expect(result.args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    expect(result.args[4]).toBe('""C:\\tools\\RUN.BAT" ^^^"x^^^""');
  });

  it('normalizes forward slashes in the batch path to backslashes', () => {
    const result = spawnCommand('C:/maestro/bin/maestro.bat', [], 'win32', 'cmd.exe');
    expect(result.args[4]).toBe('""C:\\maestro\\bin\\maestro.bat""');
  });

  it('falls back to cmd.exe when comspec is empty', () => {
    expect(spawnCommand('C:\\m\\maestro.bat', [], 'win32', '').command).toBe('cmd.exe');
  });

  describe('with no comspec argument', () => {
    afterEach(() => vi.unstubAllEnvs());

    // Passing undefined would use the default, process.env.ComSpec, which a real
    // Windows process always has, so the variable itself is changed. One spelling
    // only: names are case-insensitive on Windows, so stubbing a second one records
    // the first stub as its original, and the fake outlives the test.
    it('falls back to cmd.exe when the ComSpec variable is empty', () => {
      vi.stubEnv('ComSpec', '');
      expect(spawnCommand('C:\\m\\maestro.bat', [], 'win32').command).toBe('cmd.exe');
    });

    it('uses the ComSpec variable when it is set', () => {
      vi.stubEnv('ComSpec', 'D:\\win\\cmd.exe');
      expect(spawnCommand('C:\\m\\maestro.bat', [], 'win32').command).toBe('D:\\win\\cmd.exe');
    });
  });

  it.each(['a\nb', 'a\rb', 'a\r\nb'])('throws for a line break in an argument of a .bat file: %j', (arg) => {
    expect(() => spawnCommand('C:\\m\\maestro.bat', ['ok', arg], 'win32', 'cmd.exe')).toThrow(/line break/);
  });

  it('accepts line breaks on Linux', () => {
    expect(() => spawnCommand('/bin/maestro', ['a\nb', 'c\rd'], 'linux')).not.toThrow();
  });

  it('accepts line breaks for a .exe on Windows', () => {
    expect(() => spawnCommand('C:\\sdk\\adb.exe', ['a\nb'], 'win32', 'cmd.exe')).not.toThrow();
  });

  describe('escaping survives cmd.exe parsing', () => {
    /** The escaped arguments of the line, found by running the command and splitting off the file. */
    const escapedArgs = (values: string[]): string[] => {
      const line = spawnCommand('C:\\m\\maestro.bat', values, 'win32', 'cmd.exe').args[4]!.slice(1, -1);
      const prefix = '"C:\\m\\maestro.bat"';
      expect(line.startsWith(prefix)).toBe(true);
      // Every space inside an argument is caret-escaped, so only separators are bare.
      const rest = line.slice(prefix.length);
      return values.length === 0 ? [] : rest.slice(1).split(/(?<!\^) /);
    };

    it('yields the quoted argument after two parses', () => {
      const escaped = escapedArgs(NASTY);
      expect(escaped).toHaveLength(NASTY.length);
      NASTY.forEach((value, index) => {
        expect(removeCarets(removeCarets(escaped[index]!)), JSON.stringify(value)).toBe(quoteWindowsArgument(value));
      });
    });

    it('leaves every metacharacter caret-escaped after one parse', () => {
      const escaped = escapedArgs(NASTY);
      NASTY.forEach((value, index) => {
        const once = removeCarets(escaped[index]!);
        for (let i = 0; i < once.length; i += 1) {
          if (once[i] === '^') {
            i += 1; // an escaped character, whatever it is
            expect(i, JSON.stringify(value)).toBeLessThan(once.length);
          } else {
            expect(META.has(once[i]!), `${JSON.stringify(value)} has bare ${once[i]}`).toBe(false);
          }
        }
      });
    });

    it('has no unescaped metacharacter in the arguments before any parse', () => {
      const prefix = '"C:\\m\\maestro.bat"';
      const line = spawnCommand('C:\\m\\maestro.bat', ['a&b', 'x"y|z'], 'win32', 'cmd.exe').args[4]!.slice(1, -1).slice(prefix.length);
      const withoutSeparators = line.replace(/ (?=\^)/g, '');
      for (let i = 0; i < withoutSeparators.length; i += 1) {
        if (withoutSeparators[i] === '^') i += 1;
        else expect(META.has(withoutSeparators[i]!)).toBe(false);
      }
    });
  });

  describe('with a real batch file', () => {
    const values = ['plain', 'with space', 'a&b', 'a|b', 'a"b&c', '100%', '%PATH%', '!x!', '^caret', '(paren)', '<lt>', 'trailing\\', 'Ρυθμίσεις', ''];

    it.runIf(process.platform === 'win32')('passes every argument through a Maestro-style launcher unchanged', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ariadne win '));
      try {
        const dir = join(root, 'my maestro', 'bin');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'print-args.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
        const bat = join(dir, 'fake-maestro.bat');
        await writeFile(bat, '@echo off\r\nsetlocal\r\n"%NODE%" "%~dp0print-args.cjs" %*\r\n');
        const command = spawnCommand(bat, values);
        const out = await new Promise<string>((resolve, reject) => {
          const child = spawn(command.command, command.args, {
            windowsVerbatimArguments: command.windowsVerbatimArguments,
            env: { ...process.env, NODE: process.execPath },
          });
          const chunks: Buffer[] = [];
          child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.on('error', reject);
          child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        expect(JSON.parse(out)).toEqual(values);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe('pathForMaestro', () => {
  const project = 'C:\\Users\\Δημήτρης\\Documents\\Ariadne';

  it('leaves a plain path alone', () => {
    expect(pathForMaestro('C:\\Users\\jo\\Ariadne\\flows\\a.yaml', 'C:\\Users\\jo\\Ariadne', 'win32')).toBe('C:\\Users\\jo\\Ariadne\\flows\\a.yaml');
  });

  it('makes a path Java could not spell relative to the project', () => {
    expect(pathForMaestro(`${project}\\runs\\run-1\\flow.yaml`, project, 'win32')).toBe('runs\\run-1\\flow.yaml');
    expect(pathForMaestro(`${project}\\runs\\run-1`, project, 'win32')).toBe('runs\\run-1');
  });

  it('keeps the path when going relative would not help', () => {
    const outside = 'C:\\Users\\Δημήτρης\\Elsewhere\\flow.yaml';
    expect(pathForMaestro(outside, project, 'win32')).toBe(outside);
    const greekInside = `${project}\\ροές\\a.yaml`;
    expect(pathForMaestro(greekInside, project, 'win32')).toBe(greekInside);
  });

  it('changes nothing outside Windows, where Java reads paths as they are', () => {
    expect(pathForMaestro('/home/Δημήτρης/project/flow.yaml', '/home/Δημήτρης/project', 'linux')).toBe('/home/Δημήτρης/project/flow.yaml');
  });
});

describe('the tools of "Set up this computer"', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };

  it('live in the user\'s own folder on Windows, and nowhere elsewhere yet', () => {
    expect(toolsDir(env, 'win32')).toBe('C:\\Users\\u\\AppData\\Local\\Ariadne\\tools');
    expect(toolsDir({}, 'win32')).toBeUndefined();
    expect(toolsDir(env, 'linux')).toBeUndefined();
  });

  it('stay out of a folder Java could not start from, such as a Greek user name on English Windows', () => {
    const greek = { LOCALAPPDATA: 'C:\\Users\\Δημήτρης\\AppData\\Local', ProgramData: 'C:\\ProgramData' };
    expect(toolsDir(greek, 'win32')).toBe('C:\\ProgramData\\Ariadne\\tools');
    expect(toolsDir({ LOCALAPPDATA: greek.LOCALAPPDATA }, 'win32')).toBeUndefined();
  });

  it('do not mind a space in the user name', () => {
    expect(toolsDir({ LOCALAPPDATA: 'C:\\Users\\Jo Bloggs\\AppData\\Local' }, 'win32')).toBe('C:\\Users\\Jo Bloggs\\AppData\\Local\\Ariadne\\tools');
  });

  it('are where Maestro is looked for, after the usual folders and before PATH', () => {
    const candidates = maestroCandidates('win32', { ...env, PATH: 'C:\\a' }, 'C:\\Users\\u');
    const tools = candidates.indexOf('C:\\Users\\u\\AppData\\Local\\Ariadne\\tools\\maestro\\bin\\maestro.bat');
    expect(tools).toBeGreaterThan(candidates.indexOf('C:\\maestro\\bin\\maestro.bat'));
    expect(tools).toBeLessThan(candidates.indexOf('C:\\a\\maestro.bat'));
  });

  it('leave JAVA_HOME alone when no Java was fetched', () => {
    expect(toolsJavaHome(env, 'win32')).toBeUndefined();
    expect(maestroEnv(undefined, { ...env, JAVA_HOME: 'C:\\mine' }, 'win32').JAVA_HOME).toBe('C:\\mine');
  });

  // The folder is a Windows path, so this needs a real one.
  it.runIf(process.platform === 'win32')('win over a JAVA_HOME the user has, when Java was fetched', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ariadne-java-'));
    try {
      const home = join(base, 'Ariadne', 'tools', 'java');
      await mkdir(join(home, 'bin'), { recursive: true });
      await writeFile(join(home, 'bin', 'java.exe'), '');
      expect(maestroEnv(undefined, { LOCALAPPDATA: base, JAVA_HOME: 'C:\\old-java' }, 'win32').JAVA_HOME).toBe(home);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('maestroCandidates', () => {
  it('lists MAESTRO_BIN, the home install, then PATH entries on linux', () => {
    const env = { MAESTRO_BIN: '/opt/m/maestro', PATH: '/usr/bin:/usr/local/bin' };
    expect(maestroCandidates('linux', env, '/home/u')).toEqual([
      '/opt/m/maestro',
      '/home/u/.maestro/bin/maestro',
      '/usr/bin/maestro',
      '/usr/local/bin/maestro',
    ]);
  });

  it('starts at the home candidate without MAESTRO_BIN', () => {
    expect(maestroCandidates('linux', { PATH: '/usr/bin' }, '/home/u')).toEqual(['/home/u/.maestro/bin/maestro', '/usr/bin/maestro']);
  });

  it('skips empty PATH entries on linux', () => {
    expect(maestroCandidates('linux', { PATH: ':/a::/b:' }, '/h')).toEqual(['/h/.maestro/bin/maestro', '/a/maestro', '/b/maestro']);
  });

  it('copes with a missing PATH', () => {
    expect(maestroCandidates('linux', {}, '/h')).toEqual(['/h/.maestro/bin/maestro']);
  });

  it('lists .bat, .cmd, .exe per directory, home first, then SystemDrive, then PATH on win32', () => {
    const env = { MAESTRO_BIN: 'D:\\x\\maestro.bat', SystemDrive: 'E:', PATH: 'F:\\one;;G:\\two' };
    expect(maestroCandidates('win32', env, 'C:\\Users\\u')).toEqual([
      'D:\\x\\maestro.bat',
      'C:\\Users\\u\\.maestro\\bin\\maestro.bat',
      'C:\\Users\\u\\.maestro\\bin\\maestro.cmd',
      'C:\\Users\\u\\.maestro\\bin\\maestro.exe',
      'E:\\maestro\\bin\\maestro.bat',
      'E:\\maestro\\bin\\maestro.cmd',
      'E:\\maestro\\bin\\maestro.exe',
      'F:\\one\\maestro.bat',
      'F:\\one\\maestro.cmd',
      'F:\\one\\maestro.exe',
      'G:\\two\\maestro.bat',
      'G:\\two\\maestro.cmd',
      'G:\\two\\maestro.exe',
    ]);
  });

  it('defaults SystemDrive to C: on win32', () => {
    expect(maestroCandidates('win32', {}, 'C:\\Users\\u')).toContain('C:\\maestro\\bin\\maestro.bat');
  });

  it('never offers the extensionless script on win32', () => {
    const candidates = maestroCandidates('win32', { PATH: 'C:\\a;C:\\b' }, 'C:\\Users\\u');
    expect(candidates.filter((candidate) => /maestro$/.test(candidate))).toEqual([]);
  });
});

describe('maestroEnv', () => {
  it('sets ANDROID_HOME when given', () => {
    expect(maestroEnv('/sdk', { A: '1' }, 'linux')).toEqual({ A: '1', ANDROID_HOME: '/sdk' });
  });

  it('leaves ANDROID_HOME untouched when not given', () => {
    expect(maestroEnv(undefined, { ANDROID_HOME: '/old' }, 'linux')).toEqual({ ANDROID_HOME: '/old' });
  });

  it('overrides an existing ANDROID_HOME when given one', () => {
    expect(maestroEnv('/new', { ANDROID_HOME: '/old' }, 'linux').ANDROID_HOME).toBe('/new');
  });

  it('does not mutate the input env', () => {
    const env = { A: '1' };
    maestroEnv('/sdk', env, 'win32');
    expect(env).toEqual({ A: '1' });
  });

  it('sets MAESTRO_OPTS to UTF-8 output flags on win32', () => {
    expect(maestroEnv(undefined, {}, 'win32').MAESTRO_OPTS).toBe('-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8');
  });

  it('appends to an existing MAESTRO_OPTS on win32', () => {
    expect(maestroEnv(undefined, { MAESTRO_OPTS: '-Xmx2g' }, 'win32').MAESTRO_OPTS).toBe('-Xmx2g -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8');
  });

  it.each<NodeJS.Platform>(['linux', 'darwin'])('leaves an absent MAESTRO_OPTS absent on %s', (platform) => {
    expect(maestroEnv(undefined, {}, platform)).not.toHaveProperty('MAESTRO_OPTS');
  });

  it.each<NodeJS.Platform>(['linux', 'darwin'])('leaves an existing MAESTRO_OPTS as it was on %s', (platform) => {
    expect(maestroEnv(undefined, { MAESTRO_OPTS: '-Xmx2g' }, platform).MAESTRO_OPTS).toBe('-Xmx2g');
  });
});
