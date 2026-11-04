// `ariadne-studio init`: makes <folder>/.ariadne/ the Ariadne project of an
// app repository, pointed at the team's Maestro workspace when there is one.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PROJECT_GITIGNORE, type ProjectSettings } from '@ariadne/core';
import { ARIADNE_DIR } from './args.ts';

/** Where recorded case flows go inside the Maestro workspace. */
export const RECORDED_DIR = 'recorded';
/** Subfolders of a Maestro workspace that usually hold shared subflows, compared case-insensitively. */
export const BLOCK_FOLDER_NAMES = ['subflows', 'shared', 'common', 'helpers', 'utils'];

// Top-level keys of Maestro's workspace config.yaml.
const CONFIG_KEYS = /^(flows|includeTags|excludeTags|executionOrder|testOutputDir|disableRetries|platform|notifications)\s*:/m;
const APP_ID = /^appId\s*:\s*["']?([A-Za-z0-9_.]+)["']?\s*(?:#.*)?$/m;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'build', 'dist']);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasMaestroConfig(dir: string): boolean {
  for (const name of ['config.yaml', 'config.yml']) {
    const file = join(dir, name);
    try {
      if (CONFIG_KEYS.test(readFileSync(file, 'utf8'))) return true;
    } catch {
      // No such file.
    }
  }
  return false;
}

/**
 * The Maestro workspace of a repository: its .maestro/ folder, else the
 * folder itself or a direct subfolder holding a Maestro config.yaml.
 */
export function findMaestroWorkspace(folder: string): string | undefined {
  const dotMaestro = join(folder, '.maestro');
  if (isDirectory(dotMaestro)) return dotMaestro;
  if (hasMaestroConfig(folder)) return folder;
  let entries: string[] = [];
  try {
    entries = readdirSync(folder).sort();
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (name === ARIADNE_DIR || SKIPPED_DIRS.has(name)) continue;
    const dir = join(folder, name);
    if (isDirectory(dir) && hasMaestroConfig(dir)) return dir;
  }
  return undefined;
}

/** Flow files under `dir`, a few levels deep, leaving out the workspace config and recorded flows. */
function flowFiles(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    if (isDirectory(path)) {
      if (!SKIPPED_DIRS.has(name) && name !== ARIADNE_DIR) found.push(...flowFiles(path, depth + 1));
    } else if (/\.ya?ml$/i.test(name) && !(depth === 0 && /^config\.ya?ml$/i.test(name))) {
      found.push(path);
    }
  }
  return found;
}

/** The appId most flows of the workspace use (the first one seen on a tie), and how many flows there are. */
export function commonAppId(workspace: string): { appId?: string; flowCount: number } {
  const counts = new Map<string, number>();
  const files = flowFiles(workspace);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Only the header, before the first ---, names the app.
    const header = text.split(/^---\s*$/m)[0] ?? '';
    const appId = APP_ID.exec(header)?.[1];
    if (appId) counts.set(appId, (counts.get(appId) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [appId, count] of counts) if (best === undefined || count > counts.get(best)!) best = appId;
  return best ? { appId: best, flowCount: files.length } : { flowCount: files.length };
}

/** Subfolders of the workspace named like shared subflows (subflows, shared, ...), in that order of names. */
export function blockFolders(workspace: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(workspace).filter((name) => isDirectory(join(workspace, name)));
  } catch {
    return [];
  }
  return BLOCK_FOLDER_NAMES.flatMap((wanted) => entries.filter((name) => name.toLowerCase() === wanted).sort());
}

export type InitResult = {
  projectDir: string;
  settings: ProjectSettings;
  /** The Maestro workspace found, if any. */
  workspace?: string;
  flowCount: number;
  /** Absolute paths of everything created, folders ending in the path separator. */
  created: string[];
};

export class InitError extends Error {}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Creates <folder>/.ariadne/ with project.json, cases/ and .gitignore, set up
 * for the Maestro workspace in `folder` when there is one: its most common
 * appId, flows recorded to <workspace>/recorded (created), and its
 * subflows-like folders as blocks. Refuses to replace an existing project.
 */
export function initProject(folder: string): InitResult {
  const projectDir = join(folder, ARIADNE_DIR);
  const projectFile = join(projectDir, 'project.json');
  if (existsSync(projectFile)) {
    throw new InitError(`${projectFile} already exists; this folder already has an Ariadne project. Nothing was changed.`);
  }
  const created: string[] = [];
  const makeDir = (dir: string) => {
    if (isDirectory(dir)) return;
    mkdirSync(dir, { recursive: true });
    created.push(dir + sep);
  };

  const settings: ProjectSettings = { appId: '', platform: 'android' };
  const workspace = findMaestroWorkspace(folder);
  let flowCount = 0;
  if (workspace) {
    const found = commonAppId(workspace);
    flowCount = found.flowCount;
    if (found.appId) settings.appId = found.appId;
    const fromProject = toPosix(relative(projectDir, workspace));
    const blocks = blockFolders(workspace).map((name) => `${fromProject}/${name}`);
    settings.paths = { ...(blocks.length > 0 ? { blocks } : {}), flows: `${fromProject}/${RECORDED_DIR}` };
  }

  makeDir(projectDir);
  writeFileSync(projectFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  created.push(projectFile);
  makeDir(join(projectDir, 'cases'));
  const gitignore = join(projectDir, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, PROJECT_GITIGNORE, 'utf8');
    created.push(gitignore);
  }
  if (workspace) makeDir(join(workspace, RECORDED_DIR));
  return { projectDir, settings, ...(workspace ? { workspace } : {}), flowCount, created };
}

/** What `init` prints: what it found, each thing it created, and the command to run next. */
export function initReport(result: InitResult, folder: string, cwd: string): string[] {
  // Paths under the current folder are shown relative to it, others in full.
  const shown = (path: string) => {
    const rel = relative(cwd, path);
    return rel.startsWith('..') ? path.replace(/[\\/]+$/, '') : toPosix(rel) || '.';
  };
  const lines: string[] = [];
  if (result.workspace) {
    const appId = result.settings.appId ? `, most of them for ${result.settings.appId}` : '';
    lines.push(`Found a Maestro workspace in ${shown(result.workspace)} (${result.flowCount} flow ${result.flowCount === 1 ? 'file' : 'files'}${appId}).`);
  } else {
    lines.push('No Maestro workspace found (no .maestro folder or Maestro config.yaml), so blocks and flows stay inside the project.');
  }
  lines.push('');
  for (const path of result.created) lines.push(`  created ${shown(path)}${path.endsWith(sep) ? '/' : ''}`);
  lines.push('');
  const { paths } = result.settings;
  lines.push(`  appId:  ${result.settings.appId || '(not set; enter it in the studio)'}`);
  if (paths?.flows) lines.push(`  flows:  ${paths.flows} (recorded cases are written here)`);
  lines.push(`  blocks: ${paths?.blocks?.join(', ') ?? (paths ? '(none found; add folders to "paths.blocks" in project.json)' : 'blocks/')}`);
  lines.push('');
  const target = relative(cwd, folder) && shown(folder);
  lines.push(`Next: ariadne-studio${target ? ` ${/^[\w./:\\-]+$/.test(target) ? target : `"${target}"`}` : ''}`);
  return lines;
}
