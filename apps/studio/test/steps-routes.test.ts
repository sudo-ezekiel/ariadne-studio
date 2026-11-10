// Removing, putting back and inserting steps while recording, Wait until, and
// waits added to a saved case, through the HTTP API with a fake phone.
import { mkdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodePng, type DeviceSnapshot, type OpenOptions, type Point } from '@ariadne/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server/index.ts';
import type { DeviceLike } from '../src/server/state.ts';
import type { ActionResponse, CaseDetailResponse, CaseStartResponse, CurrentCaseView } from '../src/shared/api-types.ts';

const VIEWPORT = { width: 1080, height: 2400 };
const PICTURE = encodePng({ width: 108, height: 240, channels: 1, data: new Uint8Array(108 * 240).fill(90) });
const WELCOME = { index: 0, depth: 1, rect: { x: 100, y: 1000, width: 300, height: 200 }, hittable: true, label: 'Welcome' };

/** One labelled element, or nothing at all once `empty` is set. */
class Phone implements Partial<DeviceLike> {
  target: { deviceId: string; appId: string } | undefined;
  empty = false;
  snapshots = 0;
  taps: Point[] = [];

  get isOpen() {
    return this.target !== undefined;
  }
  get deviceId() {
    return this.target?.deviceId;
  }
  get appId() {
    return this.target?.appId;
  }
  async listDevices() {
    return [];
  }
  async open(options: OpenOptions) {
    this.target = { deviceId: options.deviceId, appId: options.appId };
  }
  async close() {
    this.target = undefined;
  }
  async snapshot(): Promise<DeviceSnapshot> {
    this.snapshots += 1;
    return { nodes: this.empty ? [] : [WELCOME], viewport: VIEWPORT, takenAt: new Date().toISOString() };
  }
  async capture(screenshotPath: string) {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, PICTURE);
    return { ...(await this.snapshot()), screenshotPath };
  }
  async tapAt(point: Point) {
    this.taps.push(point);
  }
  async back() {}
  async relaunchApp() {}
  async replayFlow() {
    return { replayed: 1 };
  }
}

describe('steps while recording', () => {
  let dir: string;
  let app: FastifyInstance;
  let phone: Phone;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-steps-test-'));
    phone = new Phone();
    app = await buildServer({ projectDir: dir, session: phone as unknown as DeviceLike, phoneTools: { locked: async () => false } });
    await call('POST', '/api/session/open', { deviceId: 'phone', appId: 'app' });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as T & { error?: { code: string; message: string } } };
  }

  const exists = (relative: string) => access(join(dir, relative)).then(() => true, () => false);
  const kinds = (view: CurrentCaseView) => view.steps.map((step) => `${step.index}:${step.kind}`);

  async function recordThree(): Promise<string> {
    const { body } = await call<CaseStartResponse>('POST', '/api/case/start', { name: 'Welcome' });
    await call('POST', '/api/action/back');
    await call('POST', '/api/action/tap', { x: 200, y: 1100 });
    await call('POST', '/api/case/wait', { seconds: 5 });
    return body.caseId;
  }

  it('removes a step without touching the phone, says so, and puts it back with Undo', async () => {
    await recordThree();
    const removed = await call<CurrentCaseView>('DELETE', '/api/case/steps/2');
    expect(removed.status).toBe(200);
    expect(kinds(removed.body)).toEqual(['1:back', '2:wait']);
    expect(removed.body).toMatchObject({ removedDeviceSteps: 1, canRestore: true });
    expect(phone.taps).toHaveLength(1);

    const back = await call<CurrentCaseView>('POST', '/api/case/steps/restore');
    expect(kinds(back.body)).toEqual(['1:back', '2:tap', '3:wait']);
    expect(back.body.removedDeviceSteps).toBeUndefined();
    expect(back.body.canRestore).toBeUndefined();
    expect((await call('POST', '/api/case/steps/restore')).body.error).toEqual({ code: 'NOTHING_REMOVED', message: 'Nothing to put back.' });
  });

  it('deletes the screenshot of a removed step on Finish, and keeps the ones put back', async () => {
    const caseId = await recordThree();
    const view = (await call<CurrentCaseView>('GET', '/api/case/current')).body;
    const [back, tap] = [view.steps[0]!.screenshot!, view.steps[1]!.screenshot!];
    await call('DELETE', '/api/case/steps/2');
    await call('DELETE', '/api/case/steps/1');
    await call('POST', '/api/case/steps/restore');
    expect(await exists(tap)).toBe(true);
    expect((await call('POST', '/api/case/finish', { picks: [] })).status).toBe(200);
    expect(await exists(tap)).toBe(false);
    expect(await exists(back)).toBe(true);
    const saved = (await call<CaseDetailResponse>('GET', `/api/cases/${caseId}`)).body.case;
    expect(saved.steps.map((step) => step.kind)).toEqual(['back', 'wait']);
  });

  it('inserts a wait after a step with no screenshot, and changes its seconds', async () => {
    await recordThree();
    const captures = phone.snapshots;
    const inserted = await call<ActionResponse>('POST', '/api/case/wait', { seconds: 20, after: 0 });
    expect(inserted.status).toBe(200);
    expect(inserted.body.step).toMatchObject({ index: 1, kind: 'wait', seconds: 20 });
    expect(inserted.body.step?.screenshot).toBeUndefined();
    expect(inserted.body.screen.width).toBe(VIEWPORT.width);
    expect(phone.snapshots).toBe(captures);

    const changed = await call<CurrentCaseView>('PATCH', '/api/case/steps/1', { seconds: 8 });
    expect(changed.body.steps[0]).toMatchObject({ kind: 'wait', seconds: 8 });
    expect((await call('PATCH', '/api/case/steps/2', { seconds: 8 })).body.error?.code).toBe('NOT_A_WAIT');
    expect((await call('PATCH', '/api/case/steps/1', { seconds: 0 })).status).toBe(400);
    expect((await call('POST', '/api/case/wait', { seconds: 20, after: 5 })).body.error).toEqual({
      code: 'BAD_POSITION',
      message: 'That position is not in the case.',
    });
  });

  it('refuses to remove a step kept from the saved case while adding steps to it', async () => {
    const caseId = await recordThree();
    await call('POST', '/api/case/finish', { picks: [] });
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 2 })).status).toBe(200);
    const refused = await call('DELETE', '/api/case/steps/2');
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('KEPT_STEP');
    expect((await call('POST', '/api/case/wait', { seconds: 5, after: 1 })).body.error?.code).toBe('BAD_POSITION');
    expect((await call<ActionResponse>('POST', '/api/case/wait', { seconds: 5, after: 2 })).body.step?.index).toBe(3);
  });

  it('refuses to change the seconds of a wait kept from the saved case, and leaves them as they were', async () => {
    const caseId = await recordThree();
    await call('POST', '/api/case/finish', { picks: [] });
    // Step 3 is the saved wait; inserting after it keeps all three steps.
    expect((await call('POST', `/api/cases/${caseId}/edit`, { mode: 'insert', after: 3 })).status).toBe(200);
    const refused = await call('PATCH', '/api/case/steps/3', { seconds: 9 });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('KEPT_STEP');
    const current = (await call<CurrentCaseView>('GET', '/api/case/current')).body;
    expect(current.steps[2]).toMatchObject({ kind: 'wait', seconds: 5 });
    // A wait recorded in this edit can still be changed.
    const added = await call<ActionResponse>('POST', '/api/case/wait', { seconds: 5, after: 3 });
    expect(added.body.step?.index).toBe(4);
    expect((await call<CurrentCaseView>('PATCH', '/api/case/steps/4', { seconds: 9 })).body.steps[3]).toMatchObject({ kind: 'wait', seconds: 9 });
  });

  it('finishes and ends the recording when the screenshot of a removed step cannot be deleted', async () => {
    const caseId = await recordThree();
    const view = (await call<CurrentCaseView>('GET', '/api/case/current')).body;
    const [back, tap] = [view.steps[0]!.screenshot!, view.steps[1]!.screenshot!];
    await call('DELETE', '/api/case/steps/2');
    // A non-empty directory in place of the file makes rm(path, { force: true }) throw.
    await rm(join(dir, tap));
    mkdirSync(join(dir, tap, 'inside'), { recursive: true });
    await writeFile(join(dir, tap, 'inside', 'file.txt'), 'x');
    await expect(rm(join(dir, tap), { force: true })).rejects.toThrow();

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const finished = await call<{ caseId: string }>('POST', '/api/case/finish', { picks: [] });
      expect(finished.status).toBe(200);
      expect(finished.body.caseId).toBe(caseId);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(`could not remove ${tap}`));
    } finally {
      errors.mockRestore();
    }

    const saved = (await call<CaseDetailResponse>('GET', `/api/cases/${caseId}`)).body.case;
    expect(saved.steps.map((step) => step.kind)).toEqual(['back', 'wait']);
    expect((await call('GET', '/api/case/current')).body).toBeNull();
    const discarded = await call('POST', '/api/case/discard');
    expect(discarded.status).toBe(409);
    expect(discarded.body.error?.code).toBe('NO_CASE');
    expect(await exists(back)).toBe(true);
    expect((await call('GET', `/api/cases/${caseId}`)).status).toBe(200);
  });

  it('records a wait until on a named element, and refuses empty space', async () => {
    const { body } = await call<CaseStartResponse>('POST', '/api/case/start', { name: 'Welcome' });
    const recorded = await call<ActionResponse>('POST', '/api/case/wait-for', { x: 200, y: 1100 });
    expect(recorded.body.step).toMatchObject({ index: 1, kind: 'waitFor', selector: { kind: 'text', value: 'Welcome' }, seconds: 20 });
    expect(recorded.body.step?.screenshot).toBe(`evidence/${body.caseId}/step-001.png`);
    expect(phone.taps).toEqual([]);
    expect((await call('POST', '/api/case/wait-for', { x: 900, y: 100 })).body.error?.code).toBe('NO_ELEMENT');
    await call('POST', '/api/case/finish', { picks: [] });
    const flow = await readFile(join(dir, 'flows', `${body.caseId}.yaml`), 'utf8');
    expect(flow).toContain('- extendedWaitUntil:\n    visible:\n      text: "Welcome"\n    timeout: 20000\n    optional: true\n');
  });

  it('replays a wait until by looking at the screen, at once when the element is there and until the time runs out when not', async () => {
    const { body } = await call<CaseStartResponse>('POST', '/api/case/start', { name: 'Welcome' });
    await call('POST', '/api/case/wait-for', { x: 200, y: 1100, seconds: 1 });
    await call('POST', '/api/action/back');
    await call('POST', '/api/case/finish', { picks: [] });

    let before = phone.snapshots;
    expect((await call('POST', `/api/cases/${body.caseId}/edit`, { mode: 'insert', after: 1 })).status).toBe(200);
    expect(phone.snapshots - before).toBeLessThanOrEqual(3);
    await call('POST', '/api/case/discard');

    phone.empty = true;
    before = phone.snapshots;
    const started = Date.now();
    expect((await call('POST', `/api/cases/${body.caseId}/edit`, { mode: 'insert', after: 1 })).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(phone.snapshots - before).toBeGreaterThanOrEqual(3);
  });
});

describe('waits in a saved case', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ariadne-saved-wait-test-'));
    app = await buildServer({ projectDir: dir, session: new Phone() as unknown as DeviceLike, phoneTools: { locked: async () => false } });
    await app.inject({ method: 'POST', url: '/api/session/open', payload: { deviceId: 'phone', appId: 'app' } });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as T & { error?: { code: string; message: string } } };
  }

  it('adds a wait before step 1, changes its seconds, and marks the case edited each time', async () => {
    const { body } = await call<CaseStartResponse>('POST', '/api/case/start', { name: 'Saved' });
    await call('POST', '/api/action/back');
    await call('POST', '/api/case/finish', { picks: [] });
    const url = `/api/cases/${body.caseId}`;

    const added = await call<CaseDetailResponse>('POST', `${url}/steps`, { after: 0, kind: 'wait', seconds: 20 });
    expect(added.body.case.steps.map((step) => `${step.index}:${step.kind}`)).toEqual(['1:wait', '2:back']);
    const firstEdit = added.body.case.editedAt;
    expect(firstEdit).toBeDefined();
    expect(added.body.yaml).toContain('visible: "ariadne-wait"\n    timeout: 20000');

    const titled = await call<CaseDetailResponse>('PATCH', `${url}/steps/1`, { title: 'Let the page load' });
    expect(titled.body.case.editedAt).toBe(firstEdit);
    const changed = await call<CaseDetailResponse>('PATCH', `${url}/steps/1`, { seconds: 7 });
    expect(changed.body.case.steps[0]).toMatchObject({ kind: 'wait', seconds: 7, title: 'Let the page load' });
    expect(changed.body.yaml).toContain('timeout: 7000');
    expect(changed.body.case.editedAt! >= firstEdit!).toBe(true);

    expect((await call('PATCH', `${url}/steps/2`, { seconds: 7 })).body.error?.code).toBe('NOT_A_WAIT');
    expect((await call('POST', `${url}/steps`, { after: 3, kind: 'wait', seconds: 20 })).body.error?.code).toBe('BAD_POSITION');
  });
});
