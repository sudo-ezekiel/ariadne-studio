import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_PORT = 4711;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_SESSION = 'studio';
/** Folder created under the current one when it is not a project yet. */
export const DEFAULT_PROJECT_FOLDER = 'ariadne';

/** The project folder `ariadne-studio init` creates inside an app repository. */
export const ARIADNE_DIR = '.ariadne';

export const USAGE = `Usage: ariadne-studio [project-folder] [options]
       ariadne-studio init [folder]

Starts Ariadne Studio on this machine and opens it in your browser.

project-folder     Where cases, flows, blocks and screenshots are kept.
                   Default: the current folder if it is already an Ariadne
                   project, else its ${ARIADNE_DIR} project if it has one,
                   otherwise ./${DEFAULT_PROJECT_FOLDER} (created if missing). A folder
                   with a ${ARIADNE_DIR} project opens that project.

init [folder]      Adds Ariadne to an app repository (default: this folder):
                   creates ${ARIADNE_DIR}/ and points it at the repository's
                   Maestro workspace (.maestro/) when there is one.

Options:
  -p, --port <n>       Port to serve on (default ${DEFAULT_PORT}; 0 picks a free one)
      --host <addr>    Address to listen on (default ${DEFAULT_HOST})
      --no-open        Do not open the browser
      --session <name> Device session name, for a second studio on the same
                       machine (default "${DEFAULT_SESSION}")
  -h, --help           Show this help
  -v, --version        Show the version

Environment: ARIADNE_PROJECT_DIR, PORT, HOST and ARIADNE_SESSION_NAME are
used when the matching argument is not given. MAESTRO_BIN and ANDROID_HOME
point at Maestro and the Android SDK when they are not in the usual places.`;

export type RunOptions = {
  projectDir: string;
  port: number;
  host: string;
  sessionName: string;
  open: boolean;
};

export type CliCommand = { kind: 'help' } | { kind: 'version' } | { kind: 'init'; folder: string } | { kind: 'run'; options: RunOptions };

export class UsageError extends Error {}

/** An existing project has the layout ProjectStore creates: project.json and cases/. */
export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, 'project.json')) && existsSync(join(dir, 'cases'));
}

/** <dir>/.ariadne when an app repository keeps its Ariadne project there and `dir` is not a project itself, else `dir`. */
export function projectDirIn(dir: string): string {
  const inner = join(dir, ARIADNE_DIR);
  return !existsSync(join(dir, 'project.json')) && existsSync(join(inner, 'project.json')) ? inner : dir;
}

/**
 * The current folder when it is already a project, so running inside one
 * just works; else its .ariadne project (see `init`); else ./ariadne.
 */
export function defaultProjectDir(cwd: string): string {
  if (isProjectDir(cwd)) return resolve(cwd);
  const inner = projectDirIn(resolve(cwd));
  return inner !== resolve(cwd) ? inner : resolve(cwd, DEFAULT_PROJECT_FOLDER);
}

function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(port) || port > 65535) {
    throw new UsageError(`${source} must be a port number from 0 to 65535, got "${value}".`);
  }
  return port;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv, cwd: string): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        open: { type: 'boolean', default: true },
        session: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  if (positionals[0] === 'init') {
    if (positionals.length > 2) throw new UsageError(`Expected at most one folder after init, got ${positionals.length - 1}: ${positionals.slice(1).join(' ')}`);
    return { kind: 'init', folder: resolve(cwd, positionals[1] ?? '.') };
  }
  if (positionals.length > 1) {
    throw new UsageError(`Expected at most one project folder, got ${positionals.length}: ${positionals.join(' ')}`);
  }

  const folder = positionals[0] ?? env.ARIADNE_PROJECT_DIR;
  const projectDir = folder ? projectDirIn(resolve(cwd, folder)) : defaultProjectDir(cwd);
  const port =
    values.port !== undefined
      ? parsePort(values.port, '--port')
      : env.PORT
        ? parsePort(env.PORT, 'PORT')
        : DEFAULT_PORT;
  const host = values.host?.trim() || env.HOST?.trim() || DEFAULT_HOST;
  const sessionName = values.session?.trim() || env.ARIADNE_SESSION_NAME?.trim() || DEFAULT_SESSION;
  return { kind: 'run', options: { projectDir, port, host, sessionName, open: values.open ?? true } };
}
