import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SESSION, defaultProjectDir, isProjectDir, parseCliArgs, projectDirIn, UsageError, type RunOptions } from '../src/args.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ariadne-cli-args-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeProject(dir: string): void {
  mkdirSync(join(dir, 'cases'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), '{}');
}

function run(argv: string[], env: NodeJS.ProcessEnv = {}): RunOptions {
  const command = parseCliArgs(argv, env, cwd);
  if (command.kind !== 'run') throw new Error(`Expected a run command, got ${command.kind}`);
  return command.options;
}

describe('parseCliArgs flags', () => {
  it('returns help for --help and -h, even next to other arguments', () => {
    expect(parseCliArgs(['--help'], {}, cwd)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'], {}, cwd)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['some-folder', '--port', '1', '--help'], {}, cwd)).toEqual({ kind: 'help' });
  });

  it('returns version for --version and -v', () => {
    expect(parseCliArgs(['--version'], {}, cwd)).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'], {}, cwd)).toEqual({ kind: 'version' });
  });

  it('prefers help over version when both are given', () => {
    expect(parseCliArgs(['--version', '--help'], {}, cwd)).toEqual({ kind: 'help' });
  });

  it('uses the documented defaults with no arguments and an empty environment', () => {
    expect(run([])).toEqual({
      projectDir: resolve(cwd, 'ariadne'),
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      sessionName: DEFAULT_SESSION,
      open: true,
    });
  });

  it('turns the browser off with --no-open', () => {
    expect(run(['--no-open']).open).toBe(false);
  });

  it('reads the port from -p and --port, including the --port=N form', () => {
    expect(run(['-p', '5000']).port).toBe(5000);
    expect(run(['--port', '5001']).port).toBe(5001);
    expect(run(['--port=5002']).port).toBe(5002);
  });

  it('reads host and session from their flags', () => {
    const options = run(['--host', '0.0.0.0', '--session', 'second']);
    expect(options.host).toBe('0.0.0.0');
    expect(options.sessionName).toBe('second');
  });

  it('turns an unknown flag into a UsageError', () => {
    expect(() => parseCliArgs(['--bogus'], {}, cwd)).toThrow(UsageError);
  });

  it('turns a flag missing its value into a UsageError', () => {
    expect(() => parseCliArgs(['--port'], {}, cwd)).toThrow(UsageError);
  });
});

describe('parseCliArgs project folder', () => {
  it('resolves a relative folder against the given cwd', () => {
    expect(run(['my-tests']).projectDir).toBe(resolve(cwd, 'my-tests'));
    expect(run(['../elsewhere']).projectDir).toBe(resolve(cwd, '..', 'elsewhere'));
  });

  it('keeps an absolute folder as it is', () => {
    const absolute = join(tmpdir(), 'ariadne-absolute-folder');
    expect(run([absolute]).projectDir).toBe(absolute);
  });

  it('falls back to ARIADNE_PROJECT_DIR, resolved against cwd', () => {
    expect(run([], { ARIADNE_PROJECT_DIR: 'from-env' }).projectDir).toBe(resolve(cwd, 'from-env'));
  });

  it('lets the positional folder beat ARIADNE_PROJECT_DIR', () => {
    expect(run(['from-arg'], { ARIADNE_PROJECT_DIR: 'from-env' }).projectDir).toBe(resolve(cwd, 'from-arg'));
  });

  it('ignores an empty ARIADNE_PROJECT_DIR', () => {
    expect(run([], { ARIADNE_PROJECT_DIR: '' }).projectDir).toBe(resolve(cwd, 'ariadne'));
  });

  it('uses the cwd itself when it is already a project', () => {
    makeProject(cwd);
    expect(run([]).projectDir).toBe(resolve(cwd));
  });

  it('rejects more than one positional with a message naming them', () => {
    expect(() => parseCliArgs(['a', 'b'], {}, cwd)).toThrow(UsageError);
    expect(() => parseCliArgs(['a', 'b'], {}, cwd)).toThrow(/at most one project folder.*a b/);
  });
});

describe('parseCliArgs environment fallbacks', () => {
  it('uses PORT, HOST and ARIADNE_SESSION_NAME when no argument is given', () => {
    const options = run([], { PORT: '8123', HOST: '0.0.0.0', ARIADNE_SESSION_NAME: 'from-env' });
    expect(options).toMatchObject({ port: 8123, host: '0.0.0.0', sessionName: 'from-env' });
  });

  it('lets arguments beat the environment', () => {
    const options = run(['--port', '9000', '--host', '::1', '--session', 'arg'], { PORT: '8123', HOST: '0.0.0.0', ARIADNE_SESSION_NAME: 'env' });
    expect(options).toMatchObject({ port: 9000, host: '::1', sessionName: 'arg' });
  });

  it('lets --port 0 beat a PORT in the environment', () => {
    expect(run(['--port', '0'], { PORT: '8123' }).port).toBe(0);
  });

  it('ignores blank host and session values and uses the next source', () => {
    const options = run(['--host', '  ', '--session', ' '], { HOST: ' ', ARIADNE_SESSION_NAME: '' });
    expect(options).toMatchObject({ host: DEFAULT_HOST, sessionName: DEFAULT_SESSION });
  });

  it('trims whitespace around host and session', () => {
    const options = run(['--host', ' 0.0.0.0 ', '--session', ' two ']);
    expect(options).toMatchObject({ host: '0.0.0.0', sessionName: 'two' });
  });

  it('validates PORT from the environment and names it in the error', () => {
    expect(() => parseCliArgs([], { PORT: 'abc' }, cwd)).toThrow(/PORT must be a port number/);
  });
});

describe('parseCliArgs port validation', () => {
  it('allows 0 and 65535', () => {
    expect(run(['--port', '0']).port).toBe(0);
    expect(run(['--port', '65535']).port).toBe(65535);
  });

  it.each(['65536', '99999', 'abc', '80abc', '-1', '1.5', '1e3', '0x10', ''])('rejects port "%s"', (value) => {
    expect(() => parseCliArgs(['--port', value], {}, cwd)).toThrow(UsageError);
  });

  it('names --port in the error message', () => {
    expect(() => parseCliArgs(['--port', 'abc'], {}, cwd)).toThrow(/--port must be a port number from 0 to 65535, got "abc"/);
  });
});

describe('isProjectDir and defaultProjectDir', () => {
  it('is false for an empty folder and for a missing one', () => {
    expect(isProjectDir(cwd)).toBe(false);
    expect(isProjectDir(join(cwd, 'missing'))).toBe(false);
  });

  it('needs both project.json and cases/', () => {
    writeFileSync(join(cwd, 'project.json'), '{}');
    expect(isProjectDir(cwd)).toBe(false);
    mkdirSync(join(cwd, 'cases'));
    expect(isProjectDir(cwd)).toBe(true);
  });

  it('is false with cases/ but no project.json', () => {
    mkdirSync(join(cwd, 'cases'));
    expect(isProjectDir(cwd)).toBe(false);
  });

  it('defaults to ./ariadne under a folder that is not a project', () => {
    expect(defaultProjectDir(cwd)).toBe(join(cwd, 'ariadne'));
  });

  it('defaults to the folder itself when it is a project', () => {
    makeProject(cwd);
    expect(defaultProjectDir(cwd)).toBe(cwd);
  });
});

describe('parseCliArgs init and .ariadne projects', () => {
  it('reads init with an optional folder, resolved against cwd', () => {
    expect(parseCliArgs(['init'], {}, cwd)).toEqual({ kind: 'init', folder: resolve(cwd) });
    expect(parseCliArgs(['init', 'app'], {}, cwd)).toEqual({ kind: 'init', folder: resolve(cwd, 'app') });
    expect(() => parseCliArgs(['init', 'a', 'b'], {}, cwd)).toThrow(UsageError);
  });

  it('opens the .ariadne project of this folder, or of a folder given, when the folder is not a project itself', () => {
    makeProject(join(cwd, '.ariadne'));
    expect(run([]).projectDir).toBe(join(cwd, '.ariadne'));
    mkdirSync(join(cwd, 'repo', '.ariadne'), { recursive: true });
    writeFileSync(join(cwd, 'repo', '.ariadne', 'project.json'), '{}');
    expect(run(['repo']).projectDir).toBe(join(cwd, 'repo', '.ariadne'));
    expect(projectDirIn(join(cwd, 'repo', '.ariadne'))).toBe(join(cwd, 'repo', '.ariadne'));
    // A folder that is a project itself wins over a .ariadne inside it.
    makeProject(cwd);
    expect(defaultProjectDir(cwd)).toBe(resolve(cwd));
  });
});
