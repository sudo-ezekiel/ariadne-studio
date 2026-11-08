import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCaseId, makeRunId, makeSuiteId, parseDotEnv, PROJECT_GITIGNORE, ProjectStore, renameWhenFree, resolveProjectPaths } from '../src/project/store.ts';
import type { MaestroFlow, MaestroStep } from '../src/maestro/model.ts';
import type { TestCase } from '../src/recorder/case-types.ts';
import { caseToFlow, Recorder } from '../src/recorder/recorder.ts';
import type { RunSummary } from '../src/replay/run-result.ts';
import type { SuiteRun } from '../src/replay/suite.ts';

function summary(runId: string, caseId: string, startedAt: string): RunSummary {
  return {
    runId,
    caseId,
    flowFile: `flows/${caseId}.yaml`,
    startedAt,
    finishedAt: startedAt,
    exitCode: 0,
    passed: true,
    steps: [{ flowIndex: 0, step: { kind: 'launchApp' }, status: 'passed', durationMs: 400 }],
    outputFile: `runs/${runId}/output.txt`,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ariadne-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ProjectStore', () => {
  it('creates the project layout and a default project.json', async () => {
    const store = await ProjectStore.open(join(dir, 'proj'));
    expect((await readdir(store.dir)).sort()).toEqual(['.gitignore', 'blocks', 'cases', 'evidence', 'flows', 'project.json']);
    expect(await readFile(join(store.dir, '.gitignore'), 'utf8')).toBe(PROJECT_GITIGNORE);
    expect(await store.readSettings()).toEqual({ appId: '', platform: 'android' });
    await store.updateSettings({ appId: 'com.android.settings', lastDeviceId: 'emulator-5556' });
    expect(await store.readSettings()).toEqual({
      appId: 'com.android.settings',
      platform: 'android',
      lastDeviceId: 'emulator-5556',
    });
  });

  it('saves a case as JSON plus regenerated YAML and lists it', async () => {
    const store = await ProjectStore.open(dir);
    const id = await store.allocateCaseId('Open network', new Date(2026, 9, 30, 17, 12));
    expect(id).toBe('open-network-20261030-1712');
    const recorder = new Recorder();
    recorder.start({ id, name: 'Open network', appId: 'com.android.settings', deviceId: 'emulator-5556' });
    recorder.recordBack(store.evidencePath(id, 1).relative);
    const saved = await store.saveCase(recorder.toCase(), recorder.toFlow());
    expect(saved.flowPath).toBe(join(dir, 'flows', `${id}.yaml`));
    expect(await readFile(saved.flowPath, 'utf8')).toBe(saved.yaml);
    expect(saved.yaml).toContain('- back');
    const reread = await store.readCase(id);
    expect(reread.steps[0]).toMatchObject({ kind: 'back', screenshot: `evidence/${id}/step-001.png` });
    expect(await store.listCases()).toEqual([
      { id, name: 'Open network', createdAt: reread.createdAt, stepCount: 1 },
    ]);
    // Same name in the same minute gets a distinct id.
    expect(await store.allocateCaseId('Open network', new Date(2026, 9, 30, 17, 12))).toBe(`${id}-2`);
  });

  it('lists blocks, naming them from the header or the file name', async () => {
    const store = await ProjectStore.open(dir);
    await writeFile(join(dir, 'blocks', 'login.yaml'), 'appId: com.example\nname: Log in\n---\n- launchApp\n- tapOn: Login\n');
    await writeFile(join(dir, 'blocks', 'scroll.yaml'), 'appId: com.example\n---\n- waitForAnimationToEnd\n');
    await writeFile(join(dir, 'blocks', 'broken.yaml'), 'appId: com.example\n---\npressKey: Enter\n');
    await writeFile(join(dir, 'blocks', 'notes.txt'), 'ignored');
    const blocks = await store.listBlocks();
    expect(blocks.map(({ file, name }) => ({ file, name }))).toEqual([
      { file: 'blocks/broken.yaml', name: 'broken' },
      { file: 'blocks/login.yaml', name: 'Log in' },
      { file: 'blocks/scroll.yaml', name: 'scroll' },
    ]);
    expect(blocks[0]!.error).toMatch(/list of commands/);
    expect(blocks[1]).toMatchObject({ runsWith: 'agent-device' });
    expect(blocks[1]!.flow?.steps).toHaveLength(2);
    // Outside the subset: still a block, run with Maestro.
    expect(blocks[2]).toMatchObject({ runsWith: 'maestro', outline: { maestroOnly: ['waitForAnimationToEnd'] } });
    expect(blocks[2]!.flow).toBeUndefined();
    expect(blocks[2]!.error).toBeUndefined();
  });

  it('reads .env and exposes only key names for flows', async () => {
    const store = await ProjectStore.open(dir);
    await writeFile(join(dir, '.env'), '# secrets\nUSERNAME=ba@example.com\nexport PASSWORD="p=ss word"\n\nBROKEN LINE\n');
    expect(await store.readEnv()).toEqual({ USERNAME: 'ba@example.com', PASSWORD: 'p=ss word' });
    expect(await store.envKeys()).toEqual(['PASSWORD', 'USERNAME']);
  });

  it('saves, lists and reads runs of exactly one case, newest first', async () => {
    const store = await ProjectStore.open(dir);
    const caseId = 'open-network-20261030-1712';
    const first = await store.allocateRunId(caseId, new Date(2026, 9, 31, 10, 15, 42));
    expect(first).toBe('open-network-20261030-1712-20261031-101542');
    await store.saveRun(summary(first, caseId, '2026-10-31T10:15:42.000Z'));
    // Same second: a distinct id.
    const second = await store.allocateRunId(caseId, new Date(2026, 9, 31, 10, 15, 42));
    expect(second).toBe(`${first}-2`);
    await store.saveRun(summary(second, caseId, '2026-10-31T10:15:43.000Z'));
    // A run of a case whose id starts with this case's id, and a run with no summary yet.
    await store.saveRun(summary(`${caseId}-2-20261031-101600`, `${caseId}-2`, '2026-10-31T10:16:00.000Z'));
    await mkdir(store.runDir(`${caseId}-20261031-101700`), { recursive: true });
    expect((await store.listRuns(caseId)).map((run) => run.runId)).toEqual([second, first]);
    expect((await store.listRuns(`${caseId}-2`)).map((run) => run.runId)).toEqual([`${caseId}-2-20261031-101600`]);
    expect(await store.readRun(first)).toEqual(summary(first, caseId, '2026-10-31T10:15:42.000Z'));
    expect(await store.listRuns('no-such-case')).toEqual([]);
  });

  it('deletes a case with its flow, screenshots and runs, and nothing else', async () => {
    const store = await ProjectStore.open(dir);
    const ids = ['open-network-20261030-1712', 'open-network-20261030-1712-2'];
    for (const id of ids) {
      const recorder = new Recorder();
      recorder.start({ id, name: 'Open network', appId: 'com.android.settings', deviceId: 'emulator-5556' });
      const evidence = store.evidencePath(id, 1);
      recorder.recordBack(evidence.relative);
      await mkdir(store.evidenceDir(id), { recursive: true });
      await writeFile(evidence.absolute, 'png');
      await store.saveCase(recorder.toCase(), recorder.toFlow());
      const runId = makeRunId(id, new Date(2026, 9, 31, 10, 15, 42));
      await store.saveRun(summary(runId, id, '2026-10-31T10:15:42.000Z'));
      await writeFile(join(store.runDir(runId), 'output.txt'), 'ok');
    }
    await store.deleteCase(ids[0]!);
    expect(await readdir(join(dir, 'cases'))).toEqual([`${ids[1]}.json`]);
    expect(await readdir(join(dir, 'flows'))).toEqual([`${ids[1]}.yaml`]);
    expect(await readdir(join(dir, 'evidence'))).toEqual([ids[1]]);
    expect(await readdir(join(dir, 'runs'))).toEqual([`${ids[1]}-20261031-101542`]);
    expect((await store.listCases()).map((item) => item.id)).toEqual([ids[1]]);
    // Deleting again, or a case that never existed, is not an error.
    await store.deleteCase(ids[0]!);
  });

  it('refuses paths outside the project', async () => {
    const store = await ProjectStore.open(dir);
    expect(() => store.path('../outside')).toThrow(/escapes/);
    expect(store.evidencePath('case-1', 12).relative).toBe('evidence/case-1/step-012.png');
  });
});

function testCase(id: string, extra: Partial<TestCase> = {}): TestCase {
  return {
    id,
    name: `Case ${id}`,
    appId: 'com.android.settings',
    createdAt: '2026-10-30T17:12:00.000Z',
    deviceId: 'emulator-5556',
    preconditionBlocks: [],
    steps: [],
    expectations: [],
    ...extra,
  };
}

function suiteRun(suiteId: string, startedAt: string): SuiteRun {
  return { suiteId, startedAt, status: 'finished', retryFailed: true, deviceId: 'emulator-5556', cases: [] };
}

describe('ProjectStore cases that start from other cases', () => {
  it('writes only the case file, and knows which cases exist', async () => {
    const store = await ProjectStore.open(dir);
    expect(await store.hasCase('a-20261030-1712')).toBe(false);
    await store.writeCase(testCase('a-20261030-1712'));
    expect(await store.hasCase('a-20261030-1712')).toBe(true);
    expect(await store.readCase('a-20261030-1712')).toEqual(testCase('a-20261030-1712'));
    expect(await readdir(join(dir, 'flows'))).toEqual([]);
    expect((await readdir(join(dir, 'cases'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('lists startFrom, editedAt and muted, leaving out a muted false', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeCase(testCase('parent', { createdAt: '2026-10-30T10:00:00.000Z' }));
    await store.writeCase(
      testCase('child', { createdAt: '2026-10-30T11:00:00.000Z', startFrom: 'parent', editedAt: '2026-10-31T09:00:00.000Z', muted: true, steps: [{ index: 1, kind: 'back', at: '2026-10-30T11:00:00.000Z' }] }),
    );
    await store.writeCase(testCase('loud', { createdAt: '2026-10-30T12:00:00.000Z', muted: false }));
    expect(await store.listCases()).toEqual([
      { id: 'loud', name: 'Case loud', createdAt: '2026-10-30T12:00:00.000Z', stepCount: 0 },
      { id: 'child', name: 'Case child', createdAt: '2026-10-30T11:00:00.000Z', stepCount: 1, startFrom: 'parent', editedAt: '2026-10-31T09:00:00.000Z', muted: true },
      { id: 'parent', name: 'Case parent', createdAt: '2026-10-30T10:00:00.000Z', stepCount: 0 },
    ]);
  });

  it('finds the cases that start from a case', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeCase(testCase('root'));
    await store.writeCase(testCase('one', { startFrom: 'root', createdAt: '2026-10-30T18:00:00.000Z' }));
    await store.writeCase(testCase('two', { startFrom: 'root', createdAt: '2026-10-30T19:00:00.000Z' }));
    await store.writeCase(testCase('grandchild', { startFrom: 'one' }));
    expect((await store.dependentsOf('root')).sort()).toEqual(['one', 'two']);
    expect(await store.dependentsOf('one')).toEqual(['grandchild']);
    expect(await store.dependentsOf('two')).toEqual([]);
  });

  it('walks the start chain nearest first', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeCase(testCase('root'));
    await store.writeCase(testCase('middle', { startFrom: 'root' }));
    await store.writeCase(testCase('leaf', { startFrom: 'middle' }));
    expect((await store.startChain('leaf')).map((item) => item.id)).toEqual(['leaf', 'middle', 'root']);
    expect((await store.startChain('root')).map((item) => item.id)).toEqual(['root']);
  });

  it('throws on a missing parent, naming it and the case that needs it', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeCase(testCase('middle', { startFrom: 'gone' }));
    await store.writeCase(testCase('leaf', { startFrom: 'middle' }));
    await expect(store.startChain('leaf')).rejects.toThrow('Case gone is missing, but middle starts from it');
    await expect(store.startChain('nothing')).rejects.toThrow(/Case nothing is missing/);
  });

  it('throws on a loop instead of spinning', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeCase(testCase('a', { startFrom: 'b' }));
    await store.writeCase(testCase('b', { startFrom: 'a' }));
    await store.writeCase(testCase('self', { startFrom: 'self' }));
    await expect(store.startChain('a')).rejects.toThrow(/starts from itself through a > b/);
    await expect(store.startChain('self')).rejects.toThrow(/starts from itself/);
  });
});

describe('ProjectStore evidence', () => {
  it('finds the highest evidence number on disk', async () => {
    const store = await ProjectStore.open(dir);
    expect(await store.maxEvidenceNumber('case-1')).toBe(0);
    await mkdir(store.evidenceDir('case-1'), { recursive: true });
    expect(await store.maxEvidenceNumber('case-1')).toBe(0);
    for (const name of ['step-001.png', 'step-012.png', 'step-3.png', 'step-099.png.tmp', 'notes.txt', 'step-500.jpg']) {
      await writeFile(join(store.evidenceDir('case-1'), name), 'x');
    }
    expect(await store.maxEvidenceNumber('case-1')).toBe(12);
  });

  it('rewrites evidence paths of one case only', async () => {
    const store = await ProjectStore.open(dir);
    expect(store.moveEvidence('evidence/abc/step-001.png', 'abc', 'xyz')).toBe('evidence/xyz/step-001.png');
    expect(store.moveEvidence('evidence/abc-2/step-001.png', 'abc', 'xyz')).toBe('evidence/abc-2/step-001.png');
    expect(store.moveEvidence('evidence/other/step-001.png', 'abc', 'xyz')).toBe('evidence/other/step-001.png');
  });

  it('copies one evidence file to another case', async () => {
    const store = await ProjectStore.open(dir);
    await mkdir(store.evidenceDir('from'), { recursive: true });
    await writeFile(store.evidencePath('from', 3).absolute, 'png bytes');
    expect(await store.copyEvidence('evidence/from/step-003.png', 'to')).toBe('evidence/to/step-003.png');
    expect(await readFile(store.evidencePath('to', 3).absolute, 'utf8')).toBe('png bytes');
    expect(await readFile(store.evidencePath('from', 3).absolute, 'utf8')).toBe('png bytes');
    expect(await store.copyEvidence('evidence/from/step-004.png', 'to')).toBeUndefined();
    await expect(store.copyEvidence('../outside.png', 'to')).rejects.toThrow(/escapes/);
  });

  it('duplicates a case with a new id and its screenshots, without edit state', async () => {
    const store = await ProjectStore.open(dir);
    const sourceId = 'open-network-20261030-1712';
    const source = testCase(sourceId, {
      name: 'Open network',
      startFrom: 'log-in-20261030-1700',
      editedAt: '2026-10-31T09:00:00.000Z',
      muted: true,
      steps: [
        { index: 1, kind: 'back', screenshot: `evidence/${sourceId}/step-001.png`, at: '2026-10-30T17:12:00.000Z', title: 'Go back' },
        { index: 2, kind: 'back', screenshot: 'evidence/shared/step-001.png', at: '2026-10-30T17:12:00.000Z' },
        { index: 3, kind: 'back', at: '2026-10-30T17:12:00.000Z' },
      ],
      expectations: [{ selector: { kind: 'text', value: 'Wi-Fi' }, at: '2026-10-30T17:12:00.000Z' }],
    });
    await store.writeCase(source);
    await mkdir(store.evidenceDir(sourceId), { recursive: true });
    await writeFile(store.evidencePath(sourceId, 1).absolute, 'first');
    await writeFile(store.evidencePath(sourceId, 7).absolute, 'seventh');

    const date = new Date(2026, 9, 31, 11, 5);
    const copy = await store.duplicateCase(sourceId, 'Open network copy', date);
    expect(copy.id).toBe('open-network-copy-20261031-1105');
    expect(copy).toMatchObject({ name: 'Open network copy', createdAt: date.toISOString(), startFrom: 'log-in-20261030-1700', expectations: source.expectations });
    expect(copy).not.toHaveProperty('editedAt');
    expect(copy).not.toHaveProperty('muted');
    expect(copy.steps.map((step) => step.screenshot)).toEqual([`evidence/${copy.id}/step-001.png`, 'evidence/shared/step-001.png', undefined]);
    expect(copy.steps[2]).not.toHaveProperty('screenshot');
    expect(copy.steps[0]!.title).toBe('Go back');

    expect(await store.readCase(copy.id)).toEqual(copy);
    expect(await store.readCase(sourceId)).toEqual(source);
    expect((await readdir(store.evidenceDir(copy.id))).sort()).toEqual(['step-001.png', 'step-007.png']);
    expect(await readFile(store.evidencePath(copy.id, 7).absolute, 'utf8')).toBe('seventh');
    expect(await readFile(store.evidencePath(sourceId, 1).absolute, 'utf8')).toBe('first');
    // Callers write the flow.
    expect(await readdir(join(dir, 'flows'))).toEqual([]);

    const again = await store.duplicateCase(sourceId, 'Open network copy', date);
    expect(again.id).toBe(`${copy.id}-2`);
  });

  it('duplicates a case that has no evidence directory', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeCase(testCase('bare'));
    const copy = await store.duplicateCase('bare', 'Bare copy', new Date(2026, 9, 31, 11, 5));
    expect(await store.hasCase(copy.id)).toBe(true);
    expect(await readdir(join(dir, 'evidence'))).toEqual([]);
  });

  it('puts the partial flow under runs/, out of the flows folder', async () => {
    const store = await ProjectStore.open(dir);
    expect(store.partialFlowPath('case-1')).toBe(join(dir, 'runs', '_partial', 'case-1.yaml'));
    expect(store.exportsDir()).toBe(join(dir, 'exports'));
  });
});

describe('ProjectStore suite runs', () => {
  it('saves, reads and lists suite runs newest first', async () => {
    const store = await ProjectStore.open(dir);
    expect(await store.listSuites()).toEqual([]);
    const ids = [new Date(2026, 9, 31, 9, 0, 5), new Date(2026, 9, 31, 10, 15, 42), new Date(2026, 9, 30, 23, 59, 59)].map(makeSuiteId);
    expect(ids).toEqual(['suite-20261031-090005', 'suite-20261031-101542', 'suite-20261030-235959']);
    for (const id of ids) await store.saveSuite(suiteRun(id, '2026-10-31T00:00:00.000Z'));
    expect(await store.readSuite('suite-20261031-101542')).toEqual(suiteRun('suite-20261031-101542', '2026-10-31T00:00:00.000Z'));
    expect((await store.listSuites()).map((item) => item.suiteId)).toEqual(['suite-20261031-101542', 'suite-20261031-090005', 'suite-20261030-235959']);
    expect((await store.listSuites(2)).map((item) => item.suiteId)).toEqual(['suite-20261031-101542', 'suite-20261031-090005']);
    expect(store.suiteFile('suite-20261031-101542')).toBe(join(dir, 'runs', '_suites', 'suite-20261031-101542.json'));
  });

  it('overwrites a suite run when it is saved again', async () => {
    const store = await ProjectStore.open(dir);
    const id = makeSuiteId(new Date(2026, 9, 31, 10, 15, 42));
    await store.saveSuite(suiteRun(id, '2026-10-31T10:15:42.000Z'));
    await store.saveSuite({ ...suiteRun(id, '2026-10-31T10:15:42.000Z'), status: 'stopped', finishedAt: '2026-10-31T10:20:00.000Z' });
    expect(await store.readSuite(id)).toMatchObject({ status: 'stopped', finishedAt: '2026-10-31T10:20:00.000Z' });
    expect(await store.listSuites()).toHaveLength(1);
  });

  it('skips unreadable suite files and ignores other files', async () => {
    const store = await ProjectStore.open(dir);
    await store.saveSuite(suiteRun('suite-20261031-090000', '2026-10-31T09:00:00.000Z'));
    await writeFile(join(dir, 'runs', '_suites', 'suite-20261031-100000.json'), '{"suiteId": "half');
    await writeFile(join(dir, 'runs', '_suites', 'suite-20261031-110000.json.123.tmp'), '{}');
    expect((await store.listSuites()).map((item) => item.suiteId)).toEqual(['suite-20261031-090000']);
  });

  it('keeps suite runs out of case runs and out of case deletion', async () => {
    const store = await ProjectStore.open(dir);
    await store.saveSuite(suiteRun('suite-20261031-090000', '2026-10-31T09:00:00.000Z'));
    expect(await store.listRuns('suite')).toEqual([]);
    expect(await store.listRuns('_suites')).toEqual([]);
    await store.deleteCase('suite');
    expect(await store.listSuites()).toHaveLength(1);
  });
});

describe('ProjectStore with paths beside a Maestro workspace', () => {
  // repo/.maestro/subflows holds the team's blocks; the project is repo/.ariadne.
  let repo: string;
  let project: string;

  async function openWithPaths(paths: unknown): Promise<ProjectStore> {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ appId: 'com.example', platform: 'android', paths }));
    return ProjectStore.open(project);
  }

  beforeEach(async () => {
    repo = join(dir, 'repo');
    project = join(repo, '.ariadne');
    await mkdir(join(repo, '.maestro', 'subflows'), { recursive: true });
  });

  it('resolves the folders against the project directory, with defaults for what is missing', () => {
    expect(resolveProjectPaths(project, undefined)).toEqual({ blockDirs: [join(project, 'blocks')], flowsDir: join(project, 'flows') });
    expect(resolveProjectPaths(project, { flows: '../.maestro/recorded' })).toEqual({
      blockDirs: [join(project, 'blocks')],
      flowsDir: join(repo, '.maestro', 'recorded'),
    });
    expect(resolveProjectPaths(project, { blocks: ['../.maestro/subflows', 'blocks', '../.maestro/subflows/'] })).toEqual({
      blockDirs: [join(repo, '.maestro', 'subflows'), join(project, 'blocks')],
      flowsDir: join(project, 'flows'),
    });
    expect(resolveProjectPaths(project, { blocks: [] }).blockDirs).toEqual([]);
  });

  it.each([
    ['a string', '../.maestro'],
    ['blocks as one string', { blocks: '../.maestro/subflows' }],
    ['an empty block folder', { blocks: [''] }],
    ['flows as a list', { flows: ['../.maestro/recorded'] }],
  ])('refuses paths given as %s', (_what, paths) => {
    expect(() => resolveProjectPaths(project, paths)).toThrow(/project\.json: "paths/);
  });

  it('creates only its own folders, and lists blocks from every block folder by project-relative path', async () => {
    await writeFile(join(repo, '.maestro', 'subflows', 'login.yaml'), 'appId: com.example\nname: Log in\n---\n- launchApp\n');
    const store = await openWithPaths({ blocks: ['../.maestro/subflows', 'blocks', '../missing'], flows: '../.maestro/recorded' });
    expect((await readdir(project)).sort()).toEqual(['blocks', 'cases', 'evidence', 'project.json']);
    expect(await readdir(join(repo, '.maestro'))).toEqual(['subflows']);
    await writeFile(join(project, 'blocks', 'own.yaml'), 'appId: com.example\n---\n- back\n');
    const blocks = await store.listBlocks();
    expect(blocks.map(({ file, name, runsWith }) => ({ file, name, runsWith }))).toEqual([
      { file: '../.maestro/subflows/login.yaml', name: 'Log in', runsWith: 'agent-device' },
      { file: 'blocks/own.yaml', name: 'own', runsWith: 'agent-device' },
    ]);
    expect(store.blockPath('../.maestro/subflows/login.yaml')).toBe(join(repo, '.maestro', 'subflows', 'login.yaml'));
    expect(store.blockPath('blocks/own.yaml')).toBe(join(project, 'blocks', 'own.yaml'));
  });

  it('refuses block paths outside both the project and the block folders', async () => {
    const store = await openWithPaths({ blocks: ['../.maestro/subflows'] });
    expect(() => store.blockPath('../.maestro/flows/x.yaml')).toThrow(/outside the project/);
    expect(() => store.blockPath('../../etc/passwd')).toThrow(/outside the project/);
    expect(() => store.blockPath('../.maestro/subflows-other/x.yaml')).toThrow(/outside the project/);
  });

  it('points a new block at another block from the first block folder', async () => {
    const store = await openWithPaths({ blocks: ['../.maestro/subflows', 'blocks'] });
    const paths = store.blockFlowPaths();
    expect(paths.runFlowFile('../.maestro/subflows/login.yaml')).toBe('login.yaml');
    expect(paths.runFlowFile('../.maestro/subflows/more/deep.yaml')).toBe('more/deep.yaml');
    // A block in a later folder is reached through the project, which sits beside the first folder's parent.
    expect(paths.runFlowFile('blocks/own.yaml')).toBe('../../.ariadne/blocks/own.yaml');
  });

  it('points a saved block at another block from the folder of that block, even one outside the project', async () => {
    const store = await openWithPaths({ blocks: ['../.maestro/subflows', 'blocks'] });
    expect(store.blockFlowPaths('../.maestro/subflows/login.yaml').runFlowFile('blocks/own.yaml')).toBe('../../.ariadne/blocks/own.yaml');
    expect(store.blockFlowPaths('blocks/own.yaml').runFlowFile('../.maestro/subflows/login.yaml')).toBe('../../.maestro/subflows/login.yaml');
    expect(store.blockFlowPaths('blocks/own.yaml').runFlowFile('blocks/other.yaml')).toBe('other.yaml');
  });

  it('refuses a block path outside the project and its block folders', async () => {
    const store = await openWithPaths({ blocks: ['blocks'] });
    expect(() => store.blockFlowPaths('../../etc/x.yaml')).toThrow(/outside the project/);
  });

  it('falls back to the project folder when project.json lists no block folders', async () => {
    const store = await openWithPaths({ blocks: [] });
    expect(store.blockFlowPaths().runFlowFile('blocks/login.yaml')).toBe('blocks/login.yaml');
  });

  it('writes case flows to the flows folder with runFlow paths relative to it, and nothing else there', async () => {
    const store = await openWithPaths({ blocks: ['../.maestro/subflows', 'blocks'], flows: '../.maestro/recorded' });
    const testCase: TestCase = {
      id: 'case-1',
      name: 'Case',
      appId: 'com.example',
      createdAt: '2026-11-03T09:00:00.000Z',
      deviceId: 'emulator-5560',
      preconditionBlocks: [{ file: '../.maestro/subflows/login.yaml' }, { file: 'blocks/own.yaml' }],
      steps: [{ index: 1, kind: 'block', file: '../.maestro/subflows/login.yaml', at: '2026-11-03T09:00:01.000Z' }],
      expectations: [],
    };
    const saved = await store.saveCase(testCase, caseToFlow(testCase, [], store));
    expect(saved.flowPath).toBe(join(repo, '.maestro', 'recorded', 'case-1.yaml'));
    expect(caseToFlow(testCase, [], store).steps).toEqual([
      { kind: 'launchApp' },
      { kind: 'runFlow', file: '../subflows/login.yaml' },
      { kind: 'runFlow', file: '../../.ariadne/blocks/own.yaml' },
      { kind: 'runFlow', file: '../subflows/login.yaml' },
    ]);
    expect(await readdir(join(repo, '.maestro', 'recorded'))).toEqual(['case-1.yaml']);
    expect(store.flowsDirFrom(store.runDir('case-1-20261103-090000'))).toBe('../../../.maestro/recorded');
    expect(store.flowsDirFrom(join(repo, '.maestro', 'recorded'))).toBe('.');
    await store.deleteCase('case-1');
    expect(await readdir(join(repo, '.maestro', 'recorded'))).toEqual([]);
  });

  it('runs a block with Maestro when a flow it runs uses commands outside the subset', async () => {
    const subflows = join(repo, '.maestro', 'subflows');
    await writeFile(join(subflows, 'outer.yaml'), 'appId: com.example\n---\n- launchApp\n- runFlow: inner.yaml\n');
    await writeFile(join(subflows, 'inner.yaml'), 'appId: com.example\n---\n- runFlow:\n    file: ../scripts/deep.yaml\n');
    await mkdir(join(repo, '.maestro', 'scripts'), { recursive: true });
    await writeFile(join(repo, '.maestro', 'scripts', 'deep.yaml'), 'appId: com.example\n---\n- runScript: x.js\n');
    await writeFile(join(subflows, 'plain.yaml'), 'appId: com.example\n---\n- runFlow: tap.yaml\n');
    await writeFile(join(subflows, 'tap.yaml'), 'appId: com.example\n---\n- tapOn: OK\n');
    await writeFile(join(subflows, 'loop.yaml'), 'appId: com.example\n---\n- runFlow: loop.yaml\n');
    await writeFile(join(subflows, 'missing.yaml'), 'appId: com.example\n---\n- runFlow: nowhere.yaml\n');
    await writeFile(join(subflows, 'variable.yaml'), 'appId: com.example\n---\n- runFlow: ${FLOW}.yaml\n');
    const store = await openWithPaths({ blocks: ['../.maestro/subflows'] });
    const byName = new Map((await store.listBlocks()).map((block) => [block.name, block]));
    expect(byName.get('outer')).toMatchObject({ runsWith: 'maestro', outline: { maestroOnly: ['runScript'] } });
    expect(byName.get('outer')!.flow).toBeUndefined();
    expect(byName.get('inner')).toMatchObject({ runsWith: 'maestro' });
    expect(byName.get('plain')).toMatchObject({ runsWith: 'agent-device' });
    expect(byName.get('plain')!.flow).toBeDefined();
    expect(byName.get('loop')).toMatchObject({ runsWith: 'agent-device' });
    expect(byName.get('missing')!.error).toMatch(/nowhere\.yaml, which does not exist/);
    expect(byName.get('variable')).toMatchObject({ runsWith: 'maestro', outline: { maestroOnly: ['runFlow ${FLOW}.yaml'] } });
  });
});

describe('ProjectStore blocks written from the Blocks tab', () => {
  const HEADER = 'appId: com.example\n---\n';
  const flowOf = (name: string, steps: MaestroStep[] = [{ kind: 'launchApp' }, { kind: 'tapOn', selector: { kind: 'text', value: 'Log in' } }]): MaestroFlow => ({
    appId: 'com.example',
    name,
    steps,
  });

  it('names a new block file after the block, and numbers the next one with the same name', async () => {
    const store = await ProjectStore.open(dir);
    expect(await store.writeBlock(flowOf('Log in'))).toBe('blocks/log-in.yaml');
    expect(await store.writeBlock(flowOf('Log in'))).toBe('blocks/log-in-2.yaml');
    expect(await store.writeBlock(flowOf('Log in'))).toBe('blocks/log-in-3.yaml');
  });

  it('says the project path a new block would get, and creates nothing', async () => {
    const store = await ProjectStore.open(dir);
    expect(await store.newBlockFile('Log in')).toBe('blocks/log-in.yaml');
    expect(await readdir(join(dir, 'blocks'))).toEqual([]);
  });

  it('says the next free name when one is taken', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeBlock(flowOf('Log in'));
    expect(await store.newBlockFile('Log in')).toBe('blocks/log-in-2.yaml');
    expect(await readdir(join(dir, 'blocks'))).toEqual(['log-in.yaml']);
  });

  it('says the file that writeBlock with no file then uses', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeBlock(flowOf('Log in'));
    await store.writeBlock(flowOf('Log in'));
    const said = await store.newBlockFile('Log in');
    expect(await store.writeBlock(flowOf('Log in'))).toBe(said);
  });

  it('says a path in the block folder outside the project in the form writeBlock answers', async () => {
    const project = join(dir, 'repo', '.ariadne');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ appId: 'com.example', platform: 'android', paths: { blocks: ['../.maestro/subflows'] } }));
    const store = await ProjectStore.open(project);
    const said = await store.newBlockFile('Log in');
    expect(said).toBe('../.maestro/subflows/log-in.yaml');
    expect(await store.writeBlock(flowOf('Log in'))).toBe(said);
  });

  it('counts an existing .yml file as taken', async () => {
    const store = await ProjectStore.open(dir);
    await writeFile(join(dir, 'blocks', 'log-in.yml'), `${HEADER}- back\n`);
    expect(await store.writeBlock(flowOf('Log in'))).toBe('blocks/log-in-2.yaml');
    expect(await readFile(join(dir, 'blocks', 'log-in.yml'), 'utf8')).toBe(`${HEADER}- back\n`);
  });

  it('falls back to block.yaml when the name has no letters or digits a file name can keep', async () => {
    const store = await ProjectStore.open(dir);
    expect(await store.writeBlock(flowOf('Σύνδεση'))).toBe('blocks/block.yaml');
    expect(await store.writeBlock(flowOf('Σύνδεση'))).toBe('blocks/block-2.yaml');
  });

  it('writes to the first block folder and creates it when it is outside the project', async () => {
    const project = join(dir, 'repo', '.ariadne');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ appId: 'com.example', platform: 'android', paths: { blocks: ['../.maestro/subflows', 'blocks'] } }));
    const store = await ProjectStore.open(project);
    expect(await store.writeBlock(flowOf('Log in'))).toBe('../.maestro/subflows/log-in.yaml');
    expect(await readdir(join(dir, 'repo', '.maestro', 'subflows'))).toEqual(['log-in.yaml']);
    expect(await readdir(join(project, 'blocks'))).toEqual([]);
  });

  it('refuses to write a new block when project.json lists no block folders', async () => {
    const project = join(dir, 'nofolders');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ appId: 'com.example', platform: 'android', paths: { blocks: [] } }));
    const store = await ProjectStore.open(project);
    await expect(store.writeBlock(flowOf('Log in'))).rejects.toThrow(/no block folders/);
  });

  it('reads back through listBlocks with the same name and steps', async () => {
    const store = await ProjectStore.open(dir);
    const steps: MaestroStep[] = [
      { kind: 'launchApp', clearState: true },
      { kind: 'tapOn', selector: { kind: 'text', value: 'Display \\(beta\\)' } },
      { kind: 'inputText', text: '${EMAIL}' },
      { kind: 'wait', seconds: 3 },
    ];
    const file = await store.writeBlock(flowOf('Log in', steps));
    const block = (await store.listBlocks()).find((candidate) => candidate.file === file);
    expect(block?.name).toBe('Log in');
    expect(block?.outline?.ownFlow?.steps).toEqual(steps);
    expect(block?.outline?.ownFlow?.appId).toBe('com.example');
  });

  it('lists a block with a wait step as run by Maestro with no flow, yet keeps ownFlow so it can be edited', async () => {
    const store = await ProjectStore.open(dir);
    const steps: MaestroStep[] = [{ kind: 'launchApp' }, { kind: 'wait', seconds: 3 }];
    await store.writeBlock(flowOf('Pause', steps));
    const [block] = await store.listBlocks();
    expect(block!.runsWith).toBe('maestro');
    expect(block!.flow).toBeUndefined();
    expect(block!.outline?.ownFlow?.steps).toEqual(steps);
  });

  it('keeps ownFlow for a block that runs a file with a wait, but not for one with runScript', async () => {
    const store = await ProjectStore.open(dir);
    await store.writeBlock(flowOf('Pause', [{ kind: 'wait', seconds: 3 }]));
    await store.writeBlock(flowOf('Outer', [{ kind: 'runFlow', file: 'pause.yaml' }]));
    await writeFile(join(dir, 'blocks', 'scripted.yaml'), `${HEADER}- launchApp\n- runScript: setup.js\n`);
    const byName = new Map((await store.listBlocks()).map((block) => [block.name, block]));
    expect(byName.get('Outer')).toMatchObject({ runsWith: 'maestro' });
    expect(byName.get('Outer')!.outline?.ownFlow?.steps).toEqual([{ kind: 'runFlow', file: 'pause.yaml' }]);
    expect(byName.get('scripted')).toMatchObject({ runsWith: 'maestro' });
    expect(byName.get('scripted')!.outline?.ownFlow).toBeUndefined();
  });

  it('overwrites the file it is given and returns that path', async () => {
    const store = await ProjectStore.open(dir);
    const file = await store.writeBlock(flowOf('Log in'));
    expect(await store.writeBlock(flowOf('Sign in', [{ kind: 'back' }]), file)).toBe(file);
    expect(await readdir(join(dir, 'blocks'))).toEqual(['log-in.yaml']);
    const [block] = await store.listBlocks();
    expect(block).toMatchObject({ file, name: 'Sign in' });
    expect(block!.outline?.ownFlow?.steps).toEqual([{ kind: 'back' }]);
  });

  describe('a block that runs a file with invalid YAML', () => {
    const INNER = 'SECRET-INNER-VALUE';

    async function listBroken(text: string) {
      const store = await ProjectStore.open(dir);
      await mkdir(join(dir, 'flows'), { recursive: true });
      await writeFile(join(dir, 'flows', 'broken.yaml'), text);
      await writeFile(join(dir, 'blocks', 'outer.yaml'), `${HEADER}- runFlow: ../flows/broken.yaml\n`);
      const [block] = await store.listBlocks();
      return block!;
    }

    it('gives an error in the "It runs ..., which cannot be read:" form that names the failure', async () => {
      const block = await listBroken(`key: a: b: ${INNER}\n`);
      expect(block.error).toMatch(/^It runs \.\.\/flows\/broken\.yaml, which cannot be read: \S/);
      expect(block.outline).toBeUndefined();
    });

    it('keeps the error to one line and does not quote the broken file or end in a colon', async () => {
      const block = await listBroken(`key: a: b: ${INNER}\nsecond: line-two\n`);
      expect(block.error).toBeDefined();
      expect(block.error).not.toContain('\n');
      expect(block.error).not.toContain(INNER);
      expect(block.error).not.toContain('line-two');
      expect(block.error).not.toMatch(/:$/);
    });

    it('keeps the full message when the block own YAML is invalid', async () => {
      const store = await ProjectStore.open(dir);
      await writeFile(join(dir, 'blocks', 'own.yaml'), `${HEADER}key: a: b: ${INNER}\n`);
      const [block] = await store.listBlocks();
      expect(block!.error).toContain('\n');
      expect(block!.error).toContain(INNER);
    });
  });

  it('removes a deleted block from the folder and from the list', async () => {
    const store = await ProjectStore.open(dir);
    const file = await store.writeBlock(flowOf('Log in'));
    await store.deleteBlock(file);
    expect(await readdir(join(dir, 'blocks'))).toEqual([]);
    expect(await store.listBlocks()).toEqual([]);
  });

  describe('reachesBlock', () => {
    /** Writes blocks/<name>.yaml with the given steps as YAML lines. */
    async function blockOn(store: ProjectStore, name: string, steps: MaestroStep[]) {
      await store.writeBlock(flowOf(name, steps), `blocks/${name}.yaml`);
    }
    const runs = (file: string): MaestroStep => ({ kind: 'runFlow', file });

    it('is true for a runFlow of the file itself', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/a.yaml', [{ kind: 'back' }, runs('a.yaml')])).toBe(true);
    });

    it('is true for the file itself spelled through another folder', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/a.yaml', [runs('../blocks/a.yaml')])).toBe(true);
    });

    it('is true for A to B to A, asked for B with steps that run A', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [runs('b.yaml')]);
      await blockOn(store, 'b', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/b.yaml', [runs('a.yaml')])).toBe(true);
    });

    it('is true through three blocks', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [runs('b.yaml')]);
      await blockOn(store, 'b', [runs('c.yaml')]);
      await blockOn(store, 'c', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/c.yaml', [runs('a.yaml')])).toBe(true);
    });

    it('is false for a chain that never returns', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [runs('b.yaml')]);
      await blockOn(store, 'b', [{ kind: 'back' }]);
      await blockOn(store, 'c', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/c.yaml', [runs('a.yaml')])).toBe(false);
    });

    it('is false, and finishes, when two other blocks loop between themselves', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'x', [runs('y.yaml')]);
      await blockOn(store, 'y', [runs('x.yaml')]);
      await blockOn(store, 'c', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/c.yaml', [runs('x.yaml')])).toBe(false);
    });

    it('is false for a runFlow path with a variable, even when the name would match', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/a.yaml', [runs('${NEXT}.yaml'), runs('${DIR}/a.yaml')])).toBe(false);
    });

    it('is false for a runFlow of a file that is not there', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [{ kind: 'back' }]);
      expect(await store.reachesBlock('blocks/a.yaml', [runs('missing.yaml')])).toBe(false);
    });

    it('is false for a runFlow of a file that is not valid YAML', async () => {
      const store = await ProjectStore.open(dir);
      await blockOn(store, 'a', [{ kind: 'back' }]);
      await writeFile(join(dir, 'blocks', 'broken.yaml'), 'appId: [unclosed\n---\n- runFlow: a.yaml: :\n  - {\n');
      expect(await store.reachesBlock('blocks/a.yaml', [runs('broken.yaml')])).toBe(false);
    });

    it('follows a block in a second block folder by its relative path', async () => {
      const project = join(dir, 'repo', '.ariadne');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'project.json'), JSON.stringify({ appId: 'com.example', platform: 'android', paths: { blocks: ['blocks', '../.maestro/subflows'] } }));
      const store = await ProjectStore.open(project);
      await mkdir(join(dir, 'repo', '.maestro', 'subflows'), { recursive: true });
      await writeFile(join(dir, 'repo', '.maestro', 'subflows', 'shared.yaml'), `${HEADER}- runFlow: ../../.ariadne/blocks/own.yaml\n`);
      await store.writeBlock(flowOf('Own', [{ kind: 'back' }]), 'blocks/own.yaml');
      expect(await store.reachesBlock('blocks/own.yaml', [runs('../../.maestro/subflows/shared.yaml')])).toBe(true);
    });
  });

  describe('changing a file that is not a block', () => {
    it.each([
      ['project.json', 'project.json'],
      ['.env', '.env'],
      ['a case file', 'cases/x.json'],
      ['a flow outside every block folder', 'flows/x.yaml'],
    ])('refuses to write over %s and leaves it as it was', async (_what, file) => {
      const store = await ProjectStore.open(dir);
      await mkdir(join(dir, 'cases'), { recursive: true });
      await mkdir(join(dir, 'flows'), { recursive: true });
      const path = join(dir, file);
      const before = file === 'project.json' ? await readFile(path, 'utf8') : 'KEEP=me\n';
      if (file !== 'project.json') await writeFile(path, before);
      await expect(store.writeBlock(flowOf('Log in'), file)).rejects.toThrow(/Not a block file/);
      expect(await readFile(path, 'utf8')).toBe(before);
    });

    it.each([
      ['project.json', 'project.json'],
      ['.env', '.env'],
      ['a case file', 'cases/x.json'],
      ['a flow outside every block folder', 'flows/x.yaml'],
    ])('refuses to delete %s and leaves it there', async (_what, file) => {
      const store = await ProjectStore.open(dir);
      await mkdir(join(dir, 'cases'), { recursive: true });
      await mkdir(join(dir, 'flows'), { recursive: true });
      const path = join(dir, file);
      if (file !== 'project.json') await writeFile(path, 'KEEP=me\n');
      const before = await readFile(path, 'utf8');
      await expect(store.deleteBlock(file)).rejects.toThrow(/Not a block file/);
      expect(await readFile(path, 'utf8')).toBe(before);
    });

    it('still accepts a .yml block inside a block folder', async () => {
      const store = await ProjectStore.open(dir);
      await writeFile(join(dir, 'blocks', 'old.yml'), `${HEADER}- back\n`);
      expect(await store.writeBlock(flowOf('Old', [{ kind: 'launchApp' }]), 'blocks/old.yml')).toBe('blocks/old.yml');
      expect(await readFile(join(dir, 'blocks', 'old.yml'), 'utf8')).toContain('launchApp');
      await store.deleteBlock('blocks/old.yml');
      expect(await readdir(join(dir, 'blocks'))).toEqual([]);
    });

    it('still writes a new block with no file when the block folder is outside the project', async () => {
      const project = join(dir, 'repo', '.ariadne');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'project.json'), JSON.stringify({ appId: 'com.example', platform: 'android', paths: { blocks: ['../.maestro/subflows'] } }));
      const store = await ProjectStore.open(project);
      expect(await store.writeBlock(flowOf('Log in'))).toBe('../.maestro/subflows/log-in.yaml');
    });
  });

  describe('blockUsers', () => {
    it('finds a case by its setup blocks and another by a block step', async () => {
      const store = await ProjectStore.open(dir);
      await store.writeBlock(flowOf('Log in'));
      await store.writeCase(testCase('uses-precondition', { name: 'Precondition case', preconditionBlocks: [{ file: 'blocks/log-in.yaml' }] }));
      await store.writeCase(
        testCase('uses-step', { name: 'Step case', steps: [{ index: 1, kind: 'block', file: 'blocks/log-in.yaml', at: '2026-10-30T17:12:00.000Z' }] }),
      );
      await store.writeCase(testCase('unrelated', { name: 'Other case', preconditionBlocks: [{ file: 'blocks/other.yaml' }] }));
      expect((await store.blockUsers('blocks/log-in.yaml')).sort()).toEqual(['Precondition case', 'Step case']);
    });

    it('finds another block that runs it with a relative runFlow, and not the block itself', async () => {
      const store = await ProjectStore.open(dir);
      await store.writeBlock(flowOf('Log in'));
      await store.writeBlock(flowOf('Morning', [{ kind: 'runFlow', file: 'log-in.yaml' }, { kind: 'back' }]));
      await store.writeBlock(flowOf('Loop', [{ kind: 'runFlow', file: 'loop.yaml' }]));
      await store.writeBlock(flowOf('Elsewhere', [{ kind: 'runFlow', file: 'other.yaml' }]));
      expect(await store.blockUsers('blocks/log-in.yaml')).toEqual(['Morning']);
      expect(await store.blockUsers('blocks/loop.yaml')).toEqual([]);
    });

    it('still lists a block that runs it and also a flow that is missing', async () => {
      const store = await ProjectStore.open(dir);
      await store.writeBlock(flowOf('Log in'));
      await writeFile(join(dir, 'blocks', 'morning.yaml'), `appId: com.example\nname: Morning\n---\n- runFlow: log-in.yaml\n- runFlow: missing.yaml\n`);
      // The broken block has no readable name, so it is listed by its file name.
      expect(await store.blockUsers('blocks/log-in.yaml')).toEqual(['morning']);
    });

    it('still lists a block that runs it and also a flow that is not valid YAML', async () => {
      const store = await ProjectStore.open(dir);
      await store.writeBlock(flowOf('Log in'));
      await writeFile(join(dir, 'blocks', 'garbled.yaml'), 'appId: [unclosed\n---\n- : : :\n');
      await writeFile(join(dir, 'blocks', 'morning.yaml'), `appId: com.example\nname: Morning\n---\n- runFlow: log-in.yaml\n- runFlow: garbled.yaml\n`);
      expect(await store.blockUsers('blocks/log-in.yaml')).toEqual(['morning']);
    });

    it('does not list a block whose own file is not valid YAML, and does not throw', async () => {
      const store = await ProjectStore.open(dir);
      await store.writeBlock(flowOf('Log in'));
      await writeFile(join(dir, 'blocks', 'garbled.yaml'), 'appId: [unclosed\n---\n- runFlow: log-in.yaml\n- : : :\n');
      await expect(store.blockUsers('blocks/log-in.yaml')).resolves.toEqual([]);
    });

    it('is empty for a block nothing uses', async () => {
      const store = await ProjectStore.open(dir);
      await store.writeBlock(flowOf('Log in'));
      await store.writeCase(testCase('plain'));
      expect(await store.blockUsers('blocks/log-in.yaml')).toEqual([]);
    });
  });
});

describe('helpers', () => {
  it('slugs case names into filesystem-safe ids', () => {
    expect(makeCaseId('Submit claim with expired policy', new Date(2026, 9, 30, 17, 12))).toBe(
      'submit-claim-with-expired-policy-20261030-1712',
    );
    expect(makeCaseId('  Café / ../etc?  ', new Date(2026, 0, 2, 3, 4))).toBe('cafe-etc-20260102-0304');
    expect(makeCaseId('!!!', new Date(2026, 0, 2, 3, 4))).toBe('case-20260102-0304');
  });

  it('parses KEY=VALUE without interpolation', () => {
    expect(parseDotEnv("A=1\nB='${A}'\nC=x=y\n")).toEqual({ A: '1', B: '${A}', C: 'x=y' });
  });
});

describe('renameWhenFree', () => {
  type Move = NonNullable<Parameters<typeof renameWhenFree>[3]>;

  function failure(code?: string): Error {
    return Object.assign(new Error(`${code ?? 'no code'}: rename failed`), code ? { code } : {});
  }

  /** Runs renameWhenFree on fake timers and settles it, returning the outcome. */
  async function settle(platform: NodeJS.Platform, move: Move): Promise<{ error?: unknown; ok: boolean }> {
    vi.useFakeTimers();
    try {
      const outcome = renameWhenFree('a.tmp', 'a', platform, move).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      return await outcome;
    } finally {
      vi.useRealTimers();
    }
  }

  it.each(['EPERM', 'EACCES', 'EBUSY'])('on win32 retries %s and succeeds on the third try', async (code) => {
    const move = vi.fn<Move>().mockRejectedValueOnce(failure(code)).mockRejectedValueOnce(failure(code)).mockResolvedValue(undefined);
    expect(await settle('win32', move)).toEqual({ ok: true });
    expect(move).toHaveBeenCalledTimes(3);
    expect(move).toHaveBeenCalledWith('a.tmp', 'a');
  });

  it('on win32 gives up after 10 tries and throws the last error', async () => {
    const errors = Array.from({ length: 10 }, () => failure('EPERM'));
    const move = vi.fn<Move>();
    for (const error of errors) move.mockRejectedValueOnce(error);
    const outcome = await settle('win32', move);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(errors[9]);
    expect(move).toHaveBeenCalledTimes(10);
  });

  it('on win32 waits 20, 40, 80, 160, 320 then 400 ms between tries', async () => {
    vi.useFakeTimers();
    try {
      const move = vi.fn<Move>().mockRejectedValue(failure('EBUSY'));
      const outcome = renameWhenFree('a.tmp', 'a', 'win32', move).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(move).toHaveBeenCalledTimes(1);
      let elapsed = 0;
      for (const [index, wait] of [20, 40, 80, 160, 320, 400, 400, 400, 400].entries()) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(move).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(move).toHaveBeenCalledTimes(index + 2);
        elapsed += wait;
      }
      expect(elapsed).toBe(2220);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<NodeJS.Platform>(['linux', 'darwin'])('on %s throws EPERM at once without retrying', async (platform) => {
    const error = failure('EPERM');
    const move = vi.fn<Move>().mockRejectedValue(error);
    const outcome = await settle(platform, move);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(error);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it.each(['ENOENT', 'EXDEV', undefined])('on win32 throws code %s at once without retrying', async (code) => {
    const error = failure(code);
    const move = vi.fn<Move>().mockRejectedValue(error);
    const outcome = await settle('win32', move);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(error);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('moves once and needs no timers when the first try works', async () => {
    const move = vi.fn<Move>().mockResolvedValue(undefined);
    expect(await settle('win32', move)).toEqual({ ok: true });
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('really moves a file with the default move', async () => {
    const from = join(dir, 'from.tmp');
    const to = join(dir, 'to.json');
    await writeFile(from, 'payload', 'utf8');
    await writeFile(to, 'old', 'utf8');
    await renameWhenFree(from, to);
    expect(await readFile(to, 'utf8')).toBe('payload');
    expect(await readdir(dir)).toEqual(['to.json']);
  });
});
