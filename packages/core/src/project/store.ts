import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseBlockFlow, type BlockOutline } from '../maestro/block-parse.ts';
import { toMaestroYaml } from '../maestro/emit.ts';
import type { MaestroFlow, MaestroStep } from '../maestro/model.ts';
import type { TestCase } from '../recorder/case-types.ts';
import type { FlowPaths } from '../recorder/recorder.ts';
import { agentDeviceReplays } from '../replay/device-replay.ts';
import type { RunSummary } from '../replay/run-result.ts';
import type { SuiteRun } from '../replay/suite.ts';

/**
 * Where blocks and case flows live, for a project kept beside an existing
 * Maestro workspace. Both are relative to the project directory.
 */
export type ProjectPaths = {
  /** Folders whose *.yaml and *.yml files are blocks; default ["blocks"]. */
  blocks?: string[];
  /** Folder the case flows <caseId>.yaml are written to; default "flows". */
  flows?: string;
};

export type ProjectSettings = {
  appId: string;
  platform: 'android';
  lastDeviceId?: string;
  env?: Record<string, string>;
  paths?: ProjectPaths;
  /** Keep a video of each run. Off unless set. */
  runVideo?: boolean;
};

/** The folders of ProjectPaths, absolute. */
export type ResolvedPaths = {
  blockDirs: string[];
  flowsDir: string;
};

export type BlockInfo = {
  /** Project-relative path, e.g. "blocks/login.yaml" or "../.maestro/subflows/login.yaml". */
  file: string;
  name: string;
  /** Every command, when Ariadne's own parser reads the whole block (and any flow it runs). */
  flow?: MaestroFlow;
  /** What Ariadne can read of the block; set unless `error` is. */
  outline?: BlockOutline;
  /**
   * How the studio runs the block on the device: agent-device replays the
   * subset Ariadne reads; anything else (runScript, a runFlow to such a
   * file, ...) runs with the Maestro CLI. Set unless `error` is.
   */
  runsWith?: 'agent-device' | 'maestro';
  /** Set when the file is not a Maestro flow at all. */
  error?: string;
};

export type CaseSummary = {
  id: string;
  name: string;
  createdAt: string;
  stepCount: number;
  startFrom?: string;
  editedAt?: string;
  muted?: boolean;
};

export type SavedCase = {
  casePath: string;
  flowPath: string;
  yaml: string;
};

export type EvidencePath = {
  absolute: string;
  /** Project-relative, forward slashes; what the case file stores. */
  relative: string;
};

/** Always inside the project directory, whatever project.json `paths` says. */
const DIRS = ['cases', 'evidence'] as const;
const DEFAULT_BLOCKS_DIR = 'blocks';
const DEFAULT_FLOWS_DIR = 'flows';

/** Suite runs live beside case runs; no case id can start with an underscore. */
const SUITES_DIR = 'runs/_suites';

/**
 * Temporary flows written for replaying part of a case. They live in the
 * project directory, never in the flows folder, so `maestro test` on that
 * folder never picks one up.
 */
const PARTIAL_FLOWS_DIR = 'runs/_partial';
const DEFAULT_SETTINGS: ProjectSettings = { appId: '', platform: 'android' };

/** What a project folder keeps out of version control: secrets and everything generated. */
export const PROJECT_GITIGNORE = ['.env', 'evidence/', 'runs/', 'exports/', 'diagnostics/', ''].join('\n');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes via a temp file and rename so a crash never leaves half a JSON file. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}

function slugify(name: string, fallback = 'case'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function timestampSuffix(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** "Submit claim" at 2026-10-30 17:12 -> "submit-claim-20261030-1712". */
export function makeCaseId(name: string, date: Date): string {
  return `${slugify(name)}-${timestampSuffix(date)}`;
}

/** A run of case "x-20261030-1712" at 2026-10-31 10:15:42 -> "x-20261030-1712-20261031-101542". */
export function makeRunId(caseId: string, date: Date): string {
  return `${caseId}-${timestampSuffix(date)}${String(date.getSeconds()).padStart(2, '0')}`;
}

/** A suite run at 2026-10-31 10:15:42 -> "suite-20261031-101542". */
export function makeSuiteId(date: Date): string {
  return `suite-${timestampSuffix(date)}${String(date.getSeconds()).padStart(2, '0')}`;
}

/**
 * Matches the run ids of exactly one case. A plain prefix match would also
 * claim the runs of "x-20261030-1712-2" for case "x-20261030-1712".
 */
function runIdPattern(caseId: string): RegExp {
  const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-\\d{8}-\\d{6}(?:-\\d+)?$`);
}

/** KEY=VALUE lines; blank lines and # comments ignored; optional quotes stripped; no interpolation. */
export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Forward-slash relative path from `fromDir` to `to`, both absolute. */
function posixRelative(fromDir: string, to: string): string {
  return relative(fromDir, to).split(sep).join('/');
}

/**
 * Absolute block and flow folders for a project's `paths`; missing entries
 * take the defaults blocks/ and flows/. Throws on a malformed value, naming it.
 */
export function resolveProjectPaths(projectDir: string, paths: unknown): ResolvedPaths {
  const dir = resolve(projectDir);
  if (paths === undefined) return { blockDirs: [join(dir, DEFAULT_BLOCKS_DIR)], flowsDir: join(dir, DEFAULT_FLOWS_DIR) };
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    throw new Error('project.json: "paths" must be an object such as { "blocks": ["../.maestro/subflows"], "flows": "../.maestro/recorded" }.');
  }
  const { blocks, flows } = paths as { blocks?: unknown; flows?: unknown };
  if (blocks !== undefined && (!Array.isArray(blocks) || !blocks.every((item) => typeof item === 'string' && item.trim() !== ''))) {
    throw new Error('project.json: "paths.blocks" must be a list of folders, such as ["../.maestro/subflows"].');
  }
  if (flows !== undefined && (typeof flows !== 'string' || flows.trim() === '')) {
    throw new Error('project.json: "paths.flows" must be a folder, such as "../.maestro/recorded".');
  }
  const blockDirs = ((blocks as string[] | undefined) ?? [DEFAULT_BLOCKS_DIR]).map((item) => resolve(dir, item));
  return { blockDirs: [...new Set(blockDirs)], flowsDir: resolve(dir, (flows as string | undefined) ?? DEFAULT_FLOWS_DIR) };
}

/**
 * The BA's test project on disk: project.json, .env, blocks/, flows/, cases/
 * and evidence/. The case JSON is the source of truth; the flow YAML is
 * regenerated from it on every save.
 */
export class ProjectStore {
  readonly dir: string;
  /** From project.json `paths`, read when the project opens. */
  private paths: ResolvedPaths;

  private constructor(dir: string) {
    this.dir = resolve(dir);
    this.paths = resolveProjectPaths(this.dir, undefined);
  }

  /** Opens a project directory, creating the layout and project.json if missing. */
  static async open(dir: string): Promise<ProjectStore> {
    const store = new ProjectStore(dir);
    await store.ensureLayout();
    return store;
  }

  /**
   * Creates what is missing: project.json (and a .gitignore beside it in a
   * new project), cases/, evidence/, and blocks/ and flows/ unless
   * project.json points elsewhere. Folders outside the project are not created.
   */
  async ensureLayout(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!(await exists(this.path('project.json')))) {
      await this.writeSettings(DEFAULT_SETTINGS);
      if (!(await exists(this.path('.gitignore')))) await writeFile(this.path('.gitignore'), PROJECT_GITIGNORE, 'utf8');
    }
    const settings = await this.readSettings();
    this.paths = resolveProjectPaths(this.dir, settings.paths);
    for (const name of DIRS) await mkdir(join(this.dir, name), { recursive: true });
    for (const folder of [...this.paths.blockDirs, this.paths.flowsDir]) {
      if (isInside(folder, this.dir)) await mkdir(folder, { recursive: true });
    }
  }

  /** The block folders and the flows folder, absolute. */
  resolvedPaths(): ResolvedPaths {
    return { blockDirs: [...this.paths.blockDirs], flowsDir: this.paths.flowsDir };
  }

  /**
   * Absolute path of a block named by its project-relative path. Refuses
   * anything outside both the project directory and the block folders.
   */
  blockPath(file: string): string {
    const absolute = resolve(this.dir, file);
    if (!isInside(absolute, this.dir) && !this.paths.blockDirs.some((dir) => isInside(absolute, dir))) {
      throw new Error(`Block path is outside the project and its block folders: ${file}`);
    }
    return absolute;
  }

  /** The runFlow file of a block (project-relative) as a case flow in the flows folder refers to it. */
  runFlowFile(blockFile: string): string {
    return posixRelative(this.paths.flowsDir, resolve(this.dir, blockFile));
  }

  /** How a block refers to another block: from its own folder, or from where a new block goes. */
  blockFlowPaths(file?: string): FlowPaths {
    const folder = file === undefined ? (this.paths.blockDirs[0] ?? this.dir) : dirname(this.blockPath(file));
    return { runFlowFile: (blockFile) => posixRelative(folder, resolve(this.dir, blockFile)) };
  }

  /** The flows folder as seen from `absoluteDir`, forward slashes, e.g. "../../flows" from runs/<runId>/. */
  flowsDirFrom(absoluteDir: string): string {
    return posixRelative(absoluteDir, this.paths.flowsDir) || '.';
  }

  /** Absolute path for a project-relative path; refuses paths that escape the project. */
  path(projectRelative: string): string {
    const absolute = resolve(this.dir, projectRelative);
    if (absolute !== this.dir && !absolute.startsWith(this.dir + sep)) {
      throw new Error(`Path escapes the project directory: ${projectRelative}`);
    }
    return absolute;
  }

  /** Project-relative path with forward slashes. */
  relative(absolute: string): string {
    const rel = relative(this.dir, isAbsolute(absolute) ? absolute : resolve(this.dir, absolute));
    return rel.split(sep).join('/');
  }

  async readSettings(): Promise<ProjectSettings> {
    const file = this.path('project.json');
    if (!(await exists(file))) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ProjectSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, platform: 'android' };
  }

  async writeSettings(settings: ProjectSettings): Promise<void> {
    await writeFileAtomic(this.path('project.json'), `${JSON.stringify(settings, null, 2)}\n`);
  }

  async updateSettings(patch: Partial<Omit<ProjectSettings, 'platform'>>): Promise<ProjectSettings> {
    const next = { ...(await this.readSettings()), ...patch, platform: 'android' as const };
    await this.writeSettings(next);
    return next;
  }

  /** Secrets for replay from .env. Missing file means no secrets. */
  async readEnv(): Promise<Record<string, string>> {
    const file = this.path('.env');
    if (!(await exists(file))) return {};
    return parseDotEnv(await readFile(file, 'utf8'));
  }

  /**
   * Adds saved values to .env, after what is there. Refuses a key that is
   * already set rather than overwrite a value the BA cannot see.
   */
  async addEnvValues(values: Readonly<Record<string, string>>): Promise<void> {
    const existing = await this.readEnv();
    const settings = await this.readSettings();
    const lines: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${key} is not a valid name for a saved value.`);
      if (key in existing || key in (settings.env ?? {})) throw new Error(`A saved value called ${key} already exists.`);
      if (/[\r\n]/.test(value)) throw new Error(`The value of ${key} must be on one line.`);
      // parseDotEnv trims and strips one pair of quotes; quote anything that would change.
      const plain = value === value.trim() && !/^["']/.test(value);
      lines.push(`${key}=${plain ? value : `"${value}"`}`);
    }
    if (lines.length === 0) return;
    const file = this.path('.env');
    const before = (await exists(file)) ? await readFile(file, 'utf8') : '';
    const separator = before === '' || before.endsWith('\n') ? '' : '\n';
    await writeFileAtomic(file, `${before}${separator}${lines.join('\n')}\n`);
  }

  /** Keys (never values) that flows may reference as ${KEY}: project.json env plus .env. */
  async envKeys(): Promise<string[]> {
    const settings = await this.readSettings();
    const keys = new Set([...Object.keys(settings.env ?? {}), ...Object.keys(await this.readEnv())]);
    return [...keys].sort();
  }

  /** Every *.yaml and *.yml file directly in each block folder, folder by folder. */
  async listBlocks(): Promise<BlockInfo[]> {
    const blocks: BlockInfo[] = [];
    for (const dir of this.paths.blockDirs) {
      if (!(await exists(dir))) continue;
      const files = (await readdir(dir)).filter((file) => /\.ya?ml$/i.test(file)).sort();
      for (const file of files) {
        const absolute = join(dir, file);
        const projectPath = this.relative(absolute);
        const fallbackName = basename(file).replace(/\.ya?ml$/i, '');
        try {
          const outline = await readBlockOutline(absolute);
          blocks.push({
            file: projectPath,
            name: outline.name ?? fallbackName,
            ...(outline.flow ? { flow: outline.flow } : {}),
            outline,
            runsWith: outline.flow ? 'agent-device' : 'maestro',
          });
        } catch (error) {
          blocks.push({
            file: projectPath,
            name: fallbackName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return blocks;
  }

  /**
   * Writes a block over its own file, or with no `file` to a new one named
   * after it in the first block folder. Returns the block's project path.
   */
  async writeBlock(flow: MaestroFlow, file?: string): Promise<string> {
    const path = file === undefined ? await this.newBlockPath(flow.name ?? '') : this.blockFilePath(file);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, toMaestroYaml(flow));
    return this.relative(path);
  }

  async deleteBlock(file: string): Promise<void> {
    await rm(this.blockFilePath(file));
  }

  /** blockPath for changing a block: unlike reading, it refuses every other file in the project, such as .env. */
  private blockFilePath(file: string): string {
    const path = this.blockPath(file);
    if (!/\.ya?ml$/i.test(path) || !this.paths.blockDirs.some((dir) => isInside(path, dir))) throw new Error(`Not a block file: ${file}`);
    return path;
  }

  /**
   * Whether `steps`, as the block `file`, lead back to that file, directly or
   * through the flows they run. A flow that cannot be read leads nowhere, and
   * listBlocks reports it on its own.
   */
  async reachesBlock(file: string, steps: readonly MaestroStep[]): Promise<boolean> {
    const target = this.blockPath(file);
    const seen = new Set<string>();
    const follow = async (from: string, commands: readonly MaestroStep[]): Promise<boolean> => {
      for (const step of commands) {
        // A variable in the path is resolved by Maestro at run time; Ariadne cannot follow it.
        if (step.kind !== 'runFlow' || step.file.includes('${')) continue;
        const next = resolve(dirname(from), step.file);
        if (next === target) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        if (await follow(next, await readSteps(next))) return true;
      }
      return false;
    };
    return follow(target, steps);
  }

  /** Where a new block with this name would go, as a project path. */
  async newBlockFile(name: string): Promise<string> {
    return this.relative(await this.newBlockPath(name));
  }

  /** "Log in" -> blocks/log-in.yaml, then log-in-2.yaml. A file a case or a block runs is never reused. */
  private async newBlockPath(name: string): Promise<string> {
    const [dir] = this.paths.blockDirs;
    if (!dir) throw new Error('project.json lists no block folders in "paths.blocks".');
    const slug = slugify(name, 'block');
    for (let number = 1; ; number++) {
      const base = join(dir, number === 1 ? slug : `${slug}-${number}`);
      if (!(await exists(`${base}.yaml`)) && !(await exists(`${base}.yml`))) return `${base}.yaml`;
    }
  }

  /** The names of the saved cases and the other blocks that run a block. */
  async blockUsers(file: string): Promise<string[]> {
    const cases: string[] = [];
    for (const summary of await this.listCases()) {
      const { name, preconditionBlocks, steps } = await this.readCase(summary.id);
      if (preconditionBlocks.some((use) => use.file === file) || steps.some((step) => step.kind === 'block' && step.file === file)) cases.push(name);
    }
    const target = this.blockPath(file);
    const blocks: string[] = [];
    for (const block of await this.listBlocks()) {
      if (block.file === file) continue;
      // From the file itself: a block with another broken runFlow has no outline, and still runs this one.
      const path = this.blockPath(block.file);
      if ((await readSteps(path)).some((step) => step.kind === 'runFlow' && resolve(dirname(path), step.file) === target)) blocks.push(block.name);
    }
    return [...cases, ...blocks];
  }

  async listCases(): Promise<CaseSummary[]> {
    const dir = this.path('cases');
    if (!(await exists(dir))) return [];
    const summaries: CaseSummary[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json'))) {
      try {
        const testCase = JSON.parse(await readFile(join(dir, file), 'utf8')) as TestCase;
        summaries.push({
          id: testCase.id,
          name: testCase.name,
          createdAt: testCase.createdAt,
          stepCount: testCase.steps.length,
          ...(testCase.startFrom ? { startFrom: testCase.startFrom } : {}),
          ...(testCase.editedAt ? { editedAt: testCase.editedAt } : {}),
          ...(testCase.muted ? { muted: true } : {}),
        });
      } catch {
        // A hand-edited or half-written case should not hide the others.
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readCase(caseId: string): Promise<TestCase> {
    const testCase = JSON.parse(await readFile(this.casePath(caseId), 'utf8')) as TestCase;
    // Case files from before blocks had values list bare block paths.
    const blocks = (testCase.preconditionBlocks ?? []) as Array<TestCase['preconditionBlocks'][number] | string>;
    testCase.preconditionBlocks = blocks.map((use) => (typeof use === 'string' ? { file: use } : use));
    return testCase;
  }

  async hasCase(caseId: string): Promise<boolean> {
    return exists(this.casePath(caseId));
  }

  /** Writes cases/<id>.json only; callers regenerate the flow with writeFlow. */
  async writeCase(testCase: TestCase): Promise<void> {
    await mkdir(this.path('cases'), { recursive: true });
    await writeFileAtomic(this.casePath(testCase.id), `${JSON.stringify(testCase, null, 2)}\n`);
  }

  /** Ids of the saved cases that start from `caseId`. */
  async dependentsOf(caseId: string): Promise<string[]> {
    return (await this.listCases()).filter((item) => item.startFrom === caseId).map((item) => item.id);
  }

  /**
   * `caseId` and every case it starts from, nearest first. Throws on a missing
   * case or a loop, which only a hand-edited case file can produce.
   */
  async startChain(caseId: string): Promise<TestCase[]> {
    const chain: TestCase[] = [];
    const seen = new Set<string>();
    let next: string | undefined = caseId;
    while (next) {
      if (seen.has(next)) throw new Error(`Case ${caseId} starts from itself through ${[...seen].join(' > ')}`);
      seen.add(next);
      if (!(await exists(this.casePath(next)))) throw new Error(`Case ${next} is missing, but ${chain.at(-1)?.id ?? caseId} starts from it`);
      const testCase = await this.readCase(next);
      chain.push(testCase);
      next = testCase.startFrom;
    }
    return chain;
  }

  /** Highest NNN of evidence/<caseId>/step-NNN.png on disk, 0 when there is none. */
  async maxEvidenceNumber(caseId: string): Promise<number> {
    const dir = this.evidenceDir(caseId);
    if (!(await exists(dir))) return 0;
    let max = 0;
    for (const name of await readdir(dir)) {
      const match = /^step-(\d+)\.png$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  /**
   * Copies a case under a new id and name, with its screenshots; runs are not
   * copied. The flow is not written here, callers regenerate it.
   */
  async duplicateCase(caseId: string, name: string, date: Date = new Date()): Promise<TestCase> {
    const source = await this.readCase(caseId);
    const id = await this.allocateCaseId(name, date);
    if (await exists(this.evidenceDir(caseId))) {
      await cp(this.evidenceDir(caseId), this.evidenceDir(id), { recursive: true });
    }
    const copy: TestCase = {
      ...structuredClone(source),
      id,
      name,
      createdAt: date.toISOString(),
      steps: source.steps.map((step) => ({ ...structuredClone(step), ...(step.screenshot ? { screenshot: this.moveEvidence(step.screenshot, caseId, id) } : {}) })),
    };
    delete copy.editedAt;
    delete copy.muted;
    await this.writeCase(copy);
    return copy;
  }

  /** evidence/<from>/step-001.png -> evidence/<to>/step-001.png; other paths unchanged. */
  moveEvidence(path: string, fromCaseId: string, toCaseId: string): string {
    const prefix = `evidence/${fromCaseId}/`;
    return path.startsWith(prefix) ? `evidence/${toCaseId}/${path.slice(prefix.length)}` : path;
  }

  /** Copies one evidence file to another case's evidence directory and returns its new project path. */
  async copyEvidence(path: string, toCaseId: string): Promise<string | undefined> {
    const source = this.path(path);
    if (!(await exists(source))) return undefined;
    const target = `evidence/${toCaseId}/${basename(path)}`;
    await mkdir(this.evidenceDir(toCaseId), { recursive: true });
    await cp(source, this.path(target));
    return target;
  }

  /** runs/_partial/<caseId>.yaml: part of a case, replayed to reach a step, then deleted. */
  partialFlowPath(caseId: string): string {
    return this.path(`${PARTIAL_FLOWS_DIR}/${caseId}.yaml`);
  }

  /** exports/: generated test case documents. */
  exportsDir(): string {
    return this.path('exports');
  }

  /** A suite id not used by a saved suite run or listed in `taken`. */
  async allocateSuiteId(date: Date = new Date(), taken: readonly string[] = []): Promise<string> {
    const base = makeSuiteId(date);
    let candidate = base;
    for (let n = 2; taken.includes(candidate) || (await exists(this.suiteFile(candidate))); n++) candidate = `${base}-${n}`;
    return candidate;
  }

  suiteFile(suiteId: string): string {
    return this.path(`${SUITES_DIR}/${suiteId}.json`);
  }

  async saveSuite(suite: SuiteRun): Promise<void> {
    await mkdir(this.path(SUITES_DIR), { recursive: true });
    await writeFileAtomic(this.suiteFile(suite.suiteId), `${JSON.stringify(suite, null, 2)}\n`);
  }

  async readSuite(suiteId: string): Promise<SuiteRun> {
    return JSON.parse(await readFile(this.suiteFile(suiteId), 'utf8')) as SuiteRun;
  }

  /** Suite runs, newest first. */
  async listSuites(limit = 20): Promise<SuiteRun[]> {
    const dir = this.path(SUITES_DIR);
    if (!(await exists(dir))) return [];
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, limit);
    const suites: SuiteRun[] = [];
    for (const name of names) {
      try {
        suites.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as SuiteRun);
      } catch {
        // A suite file being written right now is skipped, not fatal.
      }
    }
    return suites;
  }

  /** A case id not yet used by any case file or evidence directory. */
  async allocateCaseId(name: string, date: Date = new Date()): Promise<string> {
    const base = makeCaseId(name, date);
    let candidate = base;
    for (let n = 2; (await exists(this.casePath(candidate))) || (await exists(this.evidenceDir(candidate))); n++) {
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  casePath(caseId: string): string {
    return this.path(`cases/${caseId}.json`);
  }

  /** <flows folder>/<caseId>.yaml; the only file name the studio writes or deletes in that folder. */
  flowPath(caseId: string): string {
    return join(this.paths.flowsDir, `${caseId}.yaml`);
  }

  evidenceDir(caseId: string): string {
    return this.path(`evidence/${caseId}`);
  }

  /** evidence/<caseId>/step-NNN.png for a 1-based step index. */
  evidencePath(caseId: string, stepIndex: number): EvidencePath {
    const relativePath = `evidence/${caseId}/step-${String(stepIndex).padStart(3, '0')}.png`;
    return { absolute: this.path(relativePath), relative: relativePath };
  }

  /** runs/<runId>/: Maestro's debug output, output.txt and summary.json. */
  runDir(runId: string): string {
    return this.path(`runs/${runId}`);
  }

  /** A run id for `caseId` not yet used by a run directory. */
  async allocateRunId(caseId: string, date: Date = new Date()): Promise<string> {
    const base = makeRunId(caseId, date);
    let candidate = base;
    for (let n = 2; await exists(this.runDir(candidate)); n++) candidate = `${base}-${n}`;
    return candidate;
  }

  async saveRun(summary: RunSummary): Promise<string> {
    const dir = this.runDir(summary.runId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'summary.json');
    await writeFileAtomic(file, `${JSON.stringify(summary, null, 2)}\n`);
    return file;
  }

  async readRun(runId: string): Promise<RunSummary> {
    return JSON.parse(await readFile(join(this.runDir(runId), 'summary.json'), 'utf8')) as RunSummary;
  }

  /** Runs of one case that have a summary, newest first. */
  async listRuns(caseId: string): Promise<RunSummary[]> {
    const dir = this.path('runs');
    if (!(await exists(dir))) return [];
    const pattern = runIdPattern(caseId);
    const runs: RunSummary[] = [];
    for (const name of (await readdir(dir)).filter((entry) => pattern.test(entry))) {
      try {
        runs.push(await this.readRun(name));
      } catch {
        // A run that was stopped before its summary was written has nothing to show.
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
  }

  /** Removes the case file, its flow, its screenshots and every run of it. */
  async deleteCase(caseId: string): Promise<void> {
    await rm(this.casePath(caseId), { force: true });
    await rm(this.flowPath(caseId), { force: true });
    await rm(this.evidenceDir(caseId), { recursive: true, force: true });
    const runs = this.path('runs');
    if (!(await exists(runs))) return;
    const pattern = runIdPattern(caseId);
    for (const name of (await readdir(runs)).filter((entry) => pattern.test(entry))) {
      await rm(join(runs, name), { recursive: true, force: true });
    }
  }

  /** Writes cases/<id>.json and regenerates flows/<id>.yaml from `flow`. */
  async saveCase(testCase: TestCase, flow: MaestroFlow): Promise<SavedCase> {
    const casePath = this.casePath(testCase.id);
    await mkdir(this.path('cases'), { recursive: true });
    await writeFileAtomic(casePath, `${JSON.stringify(testCase, null, 2)}\n`);
    const { flowPath, yaml } = await this.writeFlow(testCase.id, flow);
    return { casePath, flowPath, yaml };
  }

  /** Writes <flows folder>/<caseId>.yaml from `flow`, replacing whatever is there. */
  async writeFlow(caseId: string, flow: MaestroFlow): Promise<{ flowPath: string; yaml: string }> {
    const flowPath = this.flowPath(caseId);
    const yaml = toMaestroYaml(flow);
    await mkdir(this.paths.flowsDir, { recursive: true });
    // Not writeFileAtomic: its temp file would appear, however briefly, in a
    // flows folder the team's own `maestro test` may be reading.
    await writeFile(flowPath, yaml, 'utf8');
    return { flowPath, yaml };
  }
}

/** The steps of a flow file that Ariadne reads; none for a file it cannot. */
async function readSteps(path: string): Promise<MaestroStep[]> {
  const outline = await readFile(path, 'utf8').then(parseBlockFlow).catch(() => undefined);
  return outline?.commands.flatMap((command) => (command.kind === 'step' ? [command.step] : [])) ?? [];
}

/** How deep runFlow files are followed when deciding whether a block needs Maestro. */
const MAX_RUNFLOW_DEPTH = 8;

/**
 * Reads a block, and every flow file it runs with runFlow: a block whose
 * runFlow reaches a command outside the subset needs Maestro as a whole,
 * because agent-device replays the files it runs too.
 */
async function readBlockOutline(absolute: string, seen: readonly string[] = []): Promise<BlockOutline> {
  const outline = parseBlockFlow(await readFile(absolute, 'utf8'));
  const chain = [...seen, absolute];
  if (chain.length > MAX_RUNFLOW_DEPTH) return outline;
  const nestedOnly = new Set<string>();
  // Ariadne reads these, but agent-device's replay would skip them (a volume
  // key, a rotation, a long press at a point), so the block runs with Maestro.
  for (const command of outline.commands) {
    if (command.kind === 'step' && !agentDeviceReplays(command.step)) nestedOnly.add(command.step.kind);
  }
  for (const command of outline.commands) {
    if (command.kind !== 'step' || command.step.kind !== 'runFlow') continue;
    const file = command.step.file;
    // A variable in the path is resolved by Maestro at run time; Ariadne cannot follow it.
    if (file.includes('${')) {
      nestedOnly.add(`runFlow ${file}`);
      continue;
    }
    const target = resolve(dirname(absolute), file);
    if (chain.includes(target)) continue;
    if (!(await exists(target))) throw new Error(`It runs ${file}, which does not exist.`);
    let nested: BlockOutline;
    try {
      nested = await readBlockOutline(target, chain);
    } catch (error) {
      throw new Error(`It runs ${file}, which cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const name of nested.maestroOnly) nestedOnly.add(name);
  }
  if (nestedOnly.size === 0) return outline;
  const { flow: _whole, ...rest } = outline;
  return { ...rest, maestroOnly: [...new Set([...outline.maestroOnly, ...nestedOnly])] };
}
