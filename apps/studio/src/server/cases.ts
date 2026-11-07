// Saved cases: detail, edits (Waldo's test builder: rename, step titles,
// delete, split, duplicate, re-record from a step, insert steps) and delete.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  Recorder,
  caseHealth,
  describeDeviceError,
  evidenceNumber,
  type CaseStep,
  type TestCase,
} from '@ariadne/core';
import type { CaseDetailResponse, CaseStartResponse, CaseRef, EditRequest } from '../shared/api-types.ts';
import {
  HttpError,
  captureScratch,
  caseFlow,
  deviceReplaySteps,
  nowIso,
  projectEnv,
  readId,
  readSavedCase,
  replayNeedsMaestro,
  replayOnDevice,
  requireNoRecording,
  requireSession,
  saveCaseAndFlow,
  writeChainFlows,
} from './common.ts';
import { runPrefixWithMaestro } from './replay.ts';
import { enqueue, toCaseView, toRunView, toScreenState, type ServerState } from './state.ts';

function renumber(steps: readonly CaseStep[]): CaseStep[] {
  return steps.map((step, position) => ({ ...step, index: position + 1 }));
}

function refuseIfRecording(state: ServerState, caseId: string): void {
  if (state.recorder?.active && state.recorder.caseId === caseId) {
    throw new HttpError(409, 'CASE_ACTIVE', 'This case is open in the recorder. Finish or discard that first.');
  }
}

function readStepNumber(params: unknown, key: string, max: number, min = 1): number {
  const raw = (params as Record<string, string | undefined>)[key];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'BAD_STEP', `Step ${raw ?? ''} does not exist; this case has ${max} step(s).`);
  }
  return value;
}

function optionalText(body: unknown, key: string, maxLength: number): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HttpError(400, 'BAD_REQUEST', `Expected "${key}" to be text of at most ${maxLength} characters.`);
  }
  return value.trim();
}

/** The detail view of a saved case: the case, its flow, its runs and its place in the start-from tree. */
export async function caseDetail(state: ServerState, caseId: string): Promise<CaseDetailResponse> {
  const testCase = await readSavedCase(state, caseId);
  const yaml = await readFile(state.project.flowPath(caseId), 'utf8').catch(() => '');
  const summaries = await state.project.listRuns(caseId);
  const all = await state.project.listCases();
  const ref = (id: string): CaseRef => ({ id, name: all.find((item) => item.id === id)?.name ?? id });
  return {
    case: toCaseView(testCase),
    yaml,
    runs: summaries.map((summary) => toRunView(summary, testCase.editedAt)),
    health: caseHealth(summaries, testCase.editedAt),
    ...(testCase.startFrom ? { parent: ref(testCase.startFrom) } : {}),
    dependents: all.filter((item) => item.startFrom === caseId).map((item) => ref(item.id)),
  };
}

/** Writes the edited case and its flow, marking it edited so older runs show as stale. */
async function saveEdited(state: ServerState, testCase: TestCase, structural: boolean): Promise<void> {
  await saveCaseAndFlow(state, structural ? { ...testCase, editedAt: nowIso() } : testCase);
}

export function registerCaseRoutes(app: FastifyInstance, state: ServerState): void {
  app.get('/api/cases/:caseId', async (request): Promise<CaseDetailResponse> => caseDetail(state, readId(request.params, 'caseId')));

  app.delete('/api/cases/:caseId', async (request) => {
    const caseId = readId(request.params, 'caseId');
    refuseIfRecording(state, caseId);
    await readSavedCase(state, caseId);
    if (state.recorder?.active && state.recorder.toCase().startFrom === caseId) {
      throw new HttpError(409, 'HAS_DEPENDENTS', 'The case being recorded starts from this one. Finish or discard it first.');
    }
    const dependents = await state.project.dependentsOf(caseId);
    if (dependents.length > 0) {
      throw new HttpError(
        409,
        'HAS_DEPENDENTS',
        `${dependents.length} case(s) start from this one (${dependents.join(', ')}). Delete or split those first.`,
      );
    }
    // Queued so a delete never races a replay writing into the same run directory.
    return enqueue(state, async () => {
      await state.project.deleteCase(caseId);
      return { ok: true };
    });
  });

  // Rename and mute do not change what the flow does, so runs stay current.
  app.patch('/api/cases/:caseId', async (request): Promise<CaseDetailResponse> => {
    const caseId = readId(request.params, 'caseId');
    refuseIfRecording(state, caseId);
    const testCase = await readSavedCase(state, caseId);
    const name = optionalText(request.body, 'name', 200);
    const muted = (request.body as { muted?: unknown } | undefined)?.muted;
    if (muted !== undefined && typeof muted !== 'boolean') throw new HttpError(400, 'BAD_REQUEST', 'Expected "muted" to be true or false.');
    if (name !== undefined) {
      if (!name) throw new HttpError(400, 'BAD_REQUEST', 'A case needs a name.');
      testCase.name = name;
    }
    if (muted === true) testCase.muted = true;
    if (muted === false) delete testCase.muted;
    await saveEdited(state, testCase, false);
    return caseDetail(state, caseId);
  });

  app.patch('/api/cases/:caseId/steps/:index', async (request): Promise<CaseDetailResponse> => {
    const caseId = readId(request.params, 'caseId');
    refuseIfRecording(state, caseId);
    const testCase = await readSavedCase(state, caseId);
    const index = readStepNumber(request.params, 'index', testCase.steps.length);
    const step = testCase.steps[index - 1]!;
    const title = optionalText(request.body, 'title', 200);
    const note = optionalText(request.body, 'note', 2000);
    if (title !== undefined) {
      if (title) step.title = title;
      else delete step.title;
    }
    if (note !== undefined) {
      if (note) step.note = note;
      else delete step.note;
    }
    if ((request.body as { review?: unknown } | undefined)?.review === null) delete step.review;
    await saveEdited(state, testCase, false);
    return caseDetail(state, caseId);
  });

  app.delete('/api/cases/:caseId/steps/:index', async (request): Promise<CaseDetailResponse> => {
    const caseId = readId(request.params, 'caseId');
    refuseIfRecording(state, caseId);
    return enqueue(state, async () => {
      const testCase = await readSavedCase(state, caseId);
      const index = readStepNumber(request.params, 'index', testCase.steps.length);
      const [removed] = testCase.steps.splice(index - 1, 1);
      testCase.steps = renumber(testCase.steps);
      if (removed?.screenshot && !testCase.steps.some((step) => step.screenshot === removed.screenshot)) {
        await rm(state.project.path(removed.screenshot), { force: true });
      }
      await saveEdited(state, testCase, true);
      return caseDetail(state, caseId);
    });
  });

  app.delete('/api/cases/:caseId/expectations/:position', async (request): Promise<CaseDetailResponse> => {
    const caseId = readId(request.params, 'caseId');
    refuseIfRecording(state, caseId);
    return enqueue(state, async () => {
      const testCase = await readSavedCase(state, caseId);
      const position = readStepNumber(request.params, 'position', testCase.expectations.length);
      testCase.expectations.splice(position - 1, 1);
      await saveEdited(state, testCase, true);
      return caseDetail(state, caseId);
    });
  });

  app.post('/api/cases/:caseId/duplicate', async (request): Promise<CaseDetailResponse> => {
    const caseId = readId(request.params, 'caseId');
    const source = await readSavedCase(state, caseId);
    const name = optionalText(request.body, 'name', 200) || `${source.name} (copy)`;
    return enqueue(state, async () => {
      const copy = await state.project.duplicateCase(caseId, name);
      await saveCaseAndFlow(state, copy);
      return caseDetail(state, copy.id);
    });
  });

  /**
   * Splits at step N: steps 1 to N become a new case that starts the way this
   * one did; this case keeps the rest and its end expectations, and starts
   * from the new one.
   */
  app.post('/api/cases/:caseId/split', async (request): Promise<CaseDetailResponse> => {
    const caseId = readId(request.params, 'caseId');
    refuseIfRecording(state, caseId);
    return enqueue(state, async () => {
      const testCase = await readSavedCase(state, caseId);
      const at = Number((request.body as { atStep?: unknown } | undefined)?.atStep);
      if (!Number.isInteger(at) || at < 1 || at > testCase.steps.length) {
        throw new HttpError(400, 'BAD_STEP', `Split after a step between 1 and ${testCase.steps.length}.`);
      }
      const name = optionalText(request.body, 'name', 200) || `${testCase.name}, start`;
      const firstId = await state.project.allocateCaseId(name);
      const moved: CaseStep[] = [];
      for (const step of testCase.steps.slice(0, at)) {
        const copied = step.screenshot ? await state.project.copyEvidence(step.screenshot, firstId) : undefined;
        const next = { ...structuredClone(step) };
        if (copied) next.screenshot = copied;
        else delete next.screenshot;
        moved.push(next);
      }
      const movedNumbers = moved.map((step) => evidenceNumber(step.screenshot) ?? 0);
      const first: TestCase = {
        ...(moved.length > 0 ? { lastEvidenceNumber: Math.max(moved.length, ...movedNumbers) } : {}),
        id: firstId,
        name,
        appId: testCase.appId,
        createdAt: nowIso(),
        deviceId: testCase.deviceId,
        preconditionBlocks: structuredClone(testCase.preconditionBlocks),
        ...(testCase.startFrom ? { startFrom: testCase.startFrom } : {}),
        steps: renumber(moved),
        expectations: [],
      };
      await saveCaseAndFlow(state, first);
      const rest: TestCase = {
        ...testCase,
        preconditionBlocks: [],
        startFrom: firstId,
        steps: renumber(testCase.steps.slice(at)),
      };
      await saveEdited(state, rest, true);
      return caseDetail(state, caseId);
    });
  });

  /**
   * Re-record from step N, or insert steps after step N: replays the case up
   * to that point through agent-device and opens the recorder there.
   */
  app.post('/api/cases/:caseId/edit', async (request): Promise<CaseStartResponse> => {
    const caseId = readId(request.params, 'caseId');
    const body = (request.body ?? {}) as Partial<EditRequest> & { step?: unknown; after?: unknown };
    requireSession(state);
    if (state.recorder?.active) {
      throw new HttpError(409, 'CASE_ACTIVE', 'A case is already being recorded. Finish or discard it first.');
    }
    const testCase = await readSavedCase(state, caseId);
    if (state.session.appId !== testCase.appId) {
      throw new HttpError(409, 'WRONG_APP', `This case is for ${testCase.appId}. Open that app first.`);
    }
    let kept: number;
    if (body.mode === 'rerecord') {
      const step = Number(body.step);
      if (!Number.isInteger(step) || step < 1 || step > testCase.steps.length) {
        throw new HttpError(400, 'BAD_STEP', `Re-record from a step between 1 and ${testCase.steps.length}.`);
      }
      kept = step - 1;
    } else if (body.mode === 'insert') {
      const after = Number(body.after);
      if (!Number.isInteger(after) || after < 0 || after > testCase.steps.length) {
        throw new HttpError(400, 'BAD_STEP', `Insert after a step between 0 and ${testCase.steps.length}.`);
      }
      kept = after;
    } else {
      throw new HttpError(400, 'BAD_REQUEST', 'Expected { mode: "rerecord", step } or { mode: "insert", after }.');
    }
    const mode = body.mode;
    const partial: TestCase = { ...testCase, steps: testCase.steps.slice(0, kept), expectations: [] };
    const withMaestro = await replayNeedsMaestro(state, partial);

    return enqueue(state, async () => {
      requireNoRecording(state);
      const { project, session } = state;
      const envKeys = await project.envKeys();
      if (withMaestro) {
        await runPrefixWithMaestro(state, { caseId, partial, what: `Running the case up to step ${kept}` });
      } else {
        if (testCase.startFrom) await writeChainFlows(state, testCase.startFrom);
        const env = await projectEnv(state);
        const partialPath = project.partialFlowPath(caseId);
        const steps = await deviceReplaySteps(state, partial, envKeys);
        await session.relaunchApp();
        try {
          // In runs/_partial/, not the flows folder; replayOnDevice rewrites runFlow paths for it.
          await replayOnDevice(state, { appId: partial.appId, name: partial.name }, steps, env, partialPath);
        } catch (error) {
          // Leave the mirror on the screen where the replay stopped.
          await captureScratch(state).catch(() => undefined);
          const described = describeDeviceError(error);
          throw new HttpError(502, described.code, `Running the case up to step ${kept} failed: ${described.message}`);
        } finally {
          await rm(partialPath, { force: true });
        }
      }
      const screen = toScreenState(await captureScratch(state));
      const floor = Math.max(
        await project.maxEvidenceNumber(caseId),
        testCase.lastEvidenceNumber ?? 0,
        testCase.steps.length,
        ...testCase.steps.map((step) => evidenceNumber(step.screenshot) ?? 0),
      );
      const recorder = new Recorder();
      recorder.start({
        id: testCase.id,
        name: testCase.name,
        appId: testCase.appId,
        deviceId: session.deviceId ?? testCase.deviceId,
        preconditionBlocks: testCase.preconditionBlocks,
        ...(testCase.startFrom ? { startFrom: testCase.startFrom } : {}),
        envKeys,
        createdAt: testCase.createdAt,
        steps: partial.steps,
        expectations: mode === 'insert' ? testCase.expectations : [],
        evidenceFloor: floor,
        editedAt: nowIso(),
        ...(testCase.muted ? { muted: true } : {}),
      });
      state.recorder = recorder;
      state.editing = {
        caseId,
        mode,
        keptSteps: kept,
        tail: mode === 'insert' ? testCase.steps.slice(kept) : [],
        originalExpectations: testCase.expectations,
        firstNewEvidence: floor + 1,
      };
      return { caseId, screen };
    });
  });
}
