// The evidence pack of a finished Run all: one page to print or save as PDF
// and hand to whoever accepts the release. Written under exports/ and shown in
// the browser.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { evidenceHtml, evidenceScreen, evidenceSteps, type EvidenceCase, type RecordFile, type ScreensMode, type SuiteRun } from '@ariadne/core';
import { HttpError, readId, reportNames } from './common.ts';
import { imageMap } from './replay.ts';
import type { ServerState } from './state.ts';

// Shown 150 px wide; twice that stays sharp on paper and keeps a pack of many cases small enough to mail.
const SCREEN_WIDTH = 300;
// The texts travel in the URL, and Node refuses a request line past 16 KB: 1,000 Greek letters are about 6 KB encoded.
const MAX_LINE = 200;
const MAX_ROLE = 40;
const MAX_NOTES = 1000;

/** Query text, trimmed; control characters become spaces, except line breaks where `multiline` keeps them. */
function readText(query: unknown, key: string, maxLength: number, multiline = false): string | undefined {
  const value = (query as Record<string, unknown> | undefined)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'BAD_REQUEST', `${key} must be text.`);
  const unified = value.replace(/\r\n?/g, '\n');
  const text = (multiline ? unified.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ') : unified.replace(/[\u0000-\u001f\u007f]+/g, ' ')).trim();
  if (text.length > maxLength) throw new HttpError(400, 'BAD_REQUEST', `${key} must be at most ${maxLength} characters.`);
  return text || undefined;
}

function readScreens(query: unknown): ScreensMode {
  const value = (query as Record<string, unknown> | undefined)?.screens;
  if (value === undefined || value === 'all') return 'all';
  if (value === 'checks') return 'checks';
  throw new HttpError(400, 'BAD_REQUEST', 'screens must be "all" or "checks".');
}

/** A project file and its SHA-256, so a reader holding the project can check the pack against it. */
function recordOf(state: ServerState, file: string, bytes: Buffer): RecordFile {
  return { path: relative(state.project.dir, file).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function registerEvidenceRoutes(app: FastifyInstance, state: ServerState): void {
  app.get('/api/suites/:suiteId/evidence', async (request, reply) => {
    const suiteId = readId(request.params, 'suiteId');
    const release = readText(request.query, 'release', MAX_LINE);
    const testedBy = readText(request.query, 'testedBy', MAX_LINE);
    const signoffRole = readText(request.query, 'signoffRole', MAX_ROLE);
    const knownIssues = readText(request.query, 'knownIssues', MAX_NOTES, true);
    const conclusion = readText(request.query, 'conclusion', MAX_LINE);
    const screens = readScreens(request.query);
    if (state.suite?.run.suiteId === suiteId && state.suite.run.status === 'running') {
      throw new HttpError(409, 'SUITE_RUNNING', 'Run all is still running. Make the evidence pack when it ends.');
    }
    // Read once, so the fingerprint is of the very bytes the pack shows.
    const suiteFile = state.project.suiteFile(suiteId);
    const suiteBytes = await readFile(suiteFile).catch(() => undefined);
    let suite: SuiteRun | undefined;
    try {
      suite = suiteBytes ? (JSON.parse(suiteBytes.toString('utf8')) as SuiteRun) : undefined;
    } catch {
      suite = undefined;
    }
    if (!suiteBytes || !suite) throw new HttpError(404, 'NOT_FOUND', `No suite run ${suiteId}.`);
    const names = await reportNames(state);
    const cases: EvidenceCase[] = [];
    for (const item of suite.cases) {
      const testCase = await state.project.readCase(item.caseId).catch(() => undefined);
      const lastRunId = item.runIds.at(-1);
      const run = lastRunId ? await state.project.readRun(lastRunId).catch(() => undefined) : undefined;
      const summaryFile = lastRunId ? join(state.project.runDir(lastRunId), 'summary.json') : undefined;
      const summaryBytes = run && summaryFile ? await readFile(summaryFile).catch(() => undefined) : undefined;
      const error = item.error ?? (run && !run.passed ? run.error : undefined);
      cases.push({
        caseId: item.caseId,
        // The name it had when it ran, which is what the summary of that Run all says too.
        name: item.name,
        outcome: item.outcome,
        attempts: item.runIds.length,
        ...(testCase ? { appId: testCase.appId } : {}),
        ...(testCase?.reference ? { reference: testCase.reference } : {}),
        ...(run
          ? {
              run: {
                runId: run.runId,
                startedAt: run.startedAt,
                passed: run.passed,
                ...(run.error ? { error: run.error } : {}),
                ...(!run.passed && run.failureScreenshot ? { failureScreenshot: run.failureScreenshot } : {}),
              },
            }
          : {}),
        ...(summaryFile && summaryBytes ? { record: recordOf(state, summaryFile, summaryBytes) } : {}),
        steps: testCase && run ? evidenceSteps(testCase, run, names) : [],
        ...(item.failedStep ? { failedStep: item.failedStep } : {}),
        ...(error ? { error } : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(testCase?.editedAt && run && run.startedAt < testCase.editedAt ? { stale: true } : {}),
        ...(testCase ? {} : { missing: true }),
      });
    }
    // Only the screens the pack shows, so a pack of checks only is small as well.
    const image = await imageMap(
      state,
      cases.flatMap((item) => [...item.steps.map((step) => evidenceScreen(step, screens, item.run?.failureScreenshot)), item.run?.failureScreenshot]),
      SCREEN_WIDTH,
    );
    const html = evidenceHtml({
      suite,
      cases,
      image,
      screens,
      record: recordOf(state, suiteFile, suiteBytes),
      ...(release ? { release } : {}),
      ...(testedBy ? { testedBy } : {}),
      ...(signoffRole ? { signoffRole } : {}),
      ...(knownIssues ? { knownIssues } : {}),
      ...(conclusion ? { conclusion } : {}),
    });
    const dir = state.project.exportsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `evidence-${suiteId}.html`), html, 'utf8');
    console.log(`[studio] wrote exports/evidence-${suiteId}.html`);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
