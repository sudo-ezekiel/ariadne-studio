// The Blocks tab: a person writes a setup block as steps in a form, and it is
// saved as the same kind of Maestro file a developer writes by hand, so
// everything that reads blocks treats it the same way.
import { readFile, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { Recorder, caseToFlow, parseMaestroFlow, toMaestroYaml, type BlockInfo, type FlowPaths, type MaestroFlow, type MaestroStep, type TestCase } from '@ariadne/core';
import type { BlockDetail, BlockRecordingResponse, BlockSaveRequest, CaseBlockDraft, CaseStartResponse } from '../shared/api-types.ts';
import { blockProblem, hideSavedValues } from '../shared/block-check.ts';
import { HttpError, captureScratch, pickedCandidates, projectEnv, readId, readPicks, readSavedCase, requireCase, requireNoRecording, requireRecording, requireSession } from './common.ts';
import { stopPhoneCapture } from './phone-capture.ts';
import { enqueue, toScreenState, type ServerState } from './state.ts';

/** A comment line, or one after a value. Text with " # " in it only adds a needless note. */
const COMMENT = /^\s*#|\s#\s/m;

async function readBlock(state: ServerState, query: unknown): Promise<BlockInfo> {
  const { file } = (query ?? {}) as { file?: unknown };
  const block = (await state.project.listBlocks()).find((candidate) => candidate.file === file);
  if (!block) throw new HttpError(404, 'UNKNOWN_BLOCK', `There is no block ${String(file)} in the project's block folders.`);
  return block;
}

function ownFlow(block: BlockInfo): MaestroFlow {
  const flow = block.outline?.ownFlow;
  if (!flow) {
    throw new HttpError(409, 'BLOCK_NOT_EDITABLE', `${block.name} uses commands Ariadne does not read, so its file can only be changed by hand.`);
  }
  return flow;
}

async function blockDetail(state: ServerState, block: BlockInfo): Promise<BlockDetail> {
  const flow = ownFlow(block);
  return {
    file: block.file,
    name: block.name,
    appId: flow.appId,
    steps: flow.steps,
    fixed: Object.keys(flow.env ?? {}),
    usedBy: await state.project.blockUsers(block.file),
    hasComments: COMMENT.test(await readFile(state.project.blockPath(block.file), 'utf8')),
  };
}

function readSave(body: unknown): BlockSaveRequest {
  const { name, steps, appId } = (body ?? {}) as Partial<BlockSaveRequest>;
  if (typeof name !== 'string' || !Array.isArray(steps) || (appId !== undefined && typeof appId !== 'string')) {
    throw new HttpError(400, 'BAD_BLOCK', 'Expected { name, steps } with the steps as a list.');
  }
  return { name: name.trim(), steps, ...(appId !== undefined ? { appId: appId.trim() } : {}) };
}

/**
 * The flow to write. Going through the file format and back refuses anything
 * that would not read as a block, so a block saved here is never a broken file.
 */
async function checkedFlow(state: ServerState, header: Omit<MaestroFlow, 'steps'>, steps: MaestroStep[]): Promise<MaestroFlow> {
  let flow: MaestroFlow;
  try {
    flow = parseMaestroFlow(toMaestroYaml({ ...header, steps }));
  } catch (error) {
    throw new HttpError(400, 'BAD_BLOCK', `These steps cannot be saved as a block: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problem = blockProblem(flow.name ?? '', flow.steps);
  if (problem) throw new HttpError(400, 'BAD_BLOCK', problem);
  return { ...flow, steps: hideSavedValues(flow.steps, await projectEnv(state)) };
}

/** A chain of cases as one list of commands: each flow but the first begins by running the one before it. */
function chainSteps(chain: readonly TestCase[], paths: FlowPaths): MaestroStep[] {
  return [...chain].reverse().flatMap((testCase, position) => caseToFlow(testCase, [], paths).steps.slice(position === 0 ? 0 : 1));
}

async function savedBlock(state: ServerState, file: string): Promise<BlockDetail> {
  return blockDetail(state, await readBlock(state, { file }));
}

export function registerBlockRoutes(app: FastifyInstance, state: ServerState): void {
  app.get('/api/blocks/detail', async (request): Promise<BlockDetail> => blockDetail(state, await readBlock(state, request.query)));

  app.post('/api/blocks', async (request): Promise<BlockDetail> => {
    const { name, steps, appId } = readSave(request.body);
    if (!appId) throw new HttpError(400, 'BAD_BLOCK', 'Enter the app id under Device first: a block says which app it is for.');
    return enqueue(state, async () => {
      requireNoRecording(state);
      const flow = await checkedFlow(state, { appId, name }, steps);
      try {
        return await savedBlock(state, await state.project.writeBlock(flow));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, 'BAD_BLOCK', error instanceof Error ? error.message : String(error));
      }
    });
  });

  // Keeps the file's own app id and header values, and the file name that cases refer to it by.
  // All in the queue: two saves checked before it could each pass, and make a loop between them.
  app.put('/api/blocks/detail', async (request): Promise<BlockDetail> => {
    const { name, steps } = readSave(request.body);
    return enqueue(state, async () => {
      requireNoRecording(state);
      const block = await readBlock(state, request.query);
      const { appId, env } = ownFlow(block);
      const flow = await checkedFlow(state, { appId, name, ...(env ? { env } : {}) }, steps);
      // Recording can put any block in, and a block that leads back to itself would never end.
      if (await state.project.reachesBlock(block.file, flow.steps)) {
        throw new HttpError(400, 'BAD_BLOCK', 'A block cannot run itself, directly or through a block it runs. Remove the step that leads back to it.');
      }
      await state.project.writeBlock(flow, block.file);
      return savedBlock(state, block.file);
    });
  });

  /** Records steps for the form, from the screen shown now: a block may be run in the middle of a case. */
  app.post('/api/blocks/record', async (request): Promise<CaseStartResponse> => {
    const { name } = (request.body ?? {}) as { name?: unknown };
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'BAD_REQUEST', 'Expected the name of the block.');
    requireSession(state);
    return enqueue(state, async () => {
      requireNoRecording(state);
      const id = await state.project.allocateCaseId('block');
      const screen = toScreenState(await captureScratch(state));
      const recorder = new Recorder();
      recorder.start({ id, name: name.trim(), appId: state.session.appId!, deviceId: state.session.deviceId!, envKeys: await state.project.envKeys() });
      state.recorder = recorder;
      state.editing = undefined;
      state.recordingBlock = true;
      return { caseId: id, screen };
    });
  });

  /** Hands the recorded steps to the form. Their screenshots go: a block keeps none. */
  app.post('/api/blocks/record/finish', async (request): Promise<BlockRecordingResponse> => {
    const picks = readPicks(request.body);
    const recorder = requireCase(state);
    if (!state.recordingBlock) throw new HttpError(409, 'NOT_RECORDING_BLOCK', 'This recording is a case. Finish it from the Record tab.');
    const { file } = (request.body ?? {}) as { file?: unknown };
    const block = file === undefined ? undefined : await readBlock(state, { file });
    await stopPhoneCapture(state);
    return enqueue(state, async () => {
      requireRecording(state, recorder);
      for (const candidate of pickedCandidates(state, picks)) recorder.addExpectation({ selector: candidate.selector, node: candidate.node });
      const testCase = recorder.toCase();
      // A flow's first command is the launchApp every case has, and a block starts where the recording did.
      const steps = caseToFlow(testCase, [], state.project.blockFlowPaths(block?.file)).steps.slice(1);
      state.recorder = undefined;
      state.recordingBlock = undefined;
      state.offered = undefined;
      // The steps are the point of the recording, so leftover pictures must not cost them. Windows can hold a file open.
      await rm(state.project.evidenceDir(testCase.id), { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
        console.error(`[studio] could not remove the screenshots in ${state.project.relative(state.project.evidenceDir(testCase.id))}: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { steps };
    });
  });

  /** A saved case as a new block, with the case it starts from written out, so the block stands alone. */
  app.get('/api/cases/:caseId/block-draft', async (request): Promise<CaseBlockDraft> => {
    const caseId = readId(request.params, 'caseId');
    const { name, appId } = await readSavedCase(state, caseId);
    let chain: TestCase[];
    try {
      chain = await state.project.startChain(caseId);
    } catch (error) {
      throw new HttpError(409, 'BROKEN_CHAIN', error instanceof Error ? error.message : String(error));
    }
    return { name, appId, steps: chainSteps(chain, state.project.blockFlowPaths()) };
  });

  app.delete('/api/blocks/detail', async (request) => {
    // Queued so a delete never pulls a file out from under a run that reads it.
    return enqueue(state, async () => {
      requireNoRecording(state);
      const block = await readBlock(state, request.query);
      const users = await state.project.blockUsers(block.file);
      if (users.length > 0) {
        throw new HttpError(409, 'BLOCK_IN_USE', `${block.name} is used by ${users.join(', ')}. Take it out of those first, or keep it.`);
      }
      await state.project.deleteBlock(block.file);
      return { ok: true };
    });
  });
}
