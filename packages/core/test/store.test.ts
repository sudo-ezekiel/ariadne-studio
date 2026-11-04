import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCaseId, makeRunId, makeSuiteId, parseDotEnv, PROJECT_GITIGNORE, ProjectStore, resolveProjectPaths } from '../src/project/store.ts';
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
