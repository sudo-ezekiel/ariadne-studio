// Test case documents: Markdown, self-contained HTML and Excel, for one case
// or the whole project. Each is written under exports/ and sent as a download.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  buildXlsx,
  caseDocument,
  caseMarkdown,
  casesHtml,
  casesSheets,
  suiteOrder,
  type CaseDocument,
  type TestCase,
} from '@ariadne/core';
import { HttpError, blockNames, caseNames, readId, readSavedCase } from './common.ts';
import type { ServerState } from './state.ts';

type Format = 'md' | 'html' | 'xlsx';

const CONTENT_TYPE: Record<Format, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function readFormat(query: unknown): Format {
  const format = (query as { format?: unknown } | undefined)?.format;
  if (format === 'md' || format === 'html' || format === 'xlsx') return format;
  throw new HttpError(400, 'BAD_FORMAT', 'Expected format=md, html or xlsx.');
}

async function documents(state: ServerState, cases: readonly TestCase[]): Promise<CaseDocument[]> {
  const names = await caseNames(state);
  const blocks = await blockNames(state);
  const docs: CaseDocument[] = [];
  for (const testCase of cases) {
    const [lastRun] = await state.project.listRuns(testCase.id);
    docs.push(caseDocument(testCase, { caseName: (id) => names.get(id), blockName: (file) => blocks.get(file) }, lastRun));
  }
  return docs;
}

async function screenshotDataUrls(state: ServerState, docs: readonly CaseDocument[]): Promise<(path: string) => string | undefined> {
  const map = new Map<string, string>();
  for (const doc of docs) {
    for (const step of doc.steps) {
      if (!step.screenshot || map.has(step.screenshot)) continue;
      try {
        const bytes = await readFile(state.project.path(step.screenshot));
        map.set(step.screenshot, `data:image/png;base64,${bytes.toString('base64')}`);
      } catch {
        // A missing screenshot leaves an empty cell.
      }
    }
  }
  return (path) => map.get(path);
}

async function render(state: ServerState, docs: readonly CaseDocument[], format: Format, title: string): Promise<Buffer> {
  switch (format) {
    case 'md':
      // exports/ sits next to evidence/, so screenshots link one level up.
      return Buffer.from(docs.map((doc) => caseMarkdown(doc, (path) => `../${path}`)).join('\n---\n\n'), 'utf8');
    case 'html':
      return Buffer.from(casesHtml(docs, await screenshotDataUrls(state, docs), title), 'utf8');
    case 'xlsx':
      return buildXlsx(casesSheets(docs));
  }
}

async function sendExport(state: ServerState, reply: FastifyReply, fileName: string, format: Format, content: Buffer): Promise<FastifyReply> {
  const dir = state.project.exportsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content);
  console.log(`[studio] wrote exports/${fileName}`);
  return reply
    .type(CONTENT_TYPE[format])
    .header('content-disposition', `attachment; filename="${fileName}"`)
    .header('cache-control', 'no-store')
    .send(content);
}

export function registerExportRoutes(app: FastifyInstance, state: ServerState): void {
  app.get('/api/cases/:caseId/export', async (request, reply) => {
    const caseId = readId(request.params, 'caseId');
    const format = readFormat(request.query);
    const testCase = await readSavedCase(state, caseId);
    const docs = await documents(state, [testCase]);
    return sendExport(state, reply, `${caseId}.${format}`, format, await render(state, docs, format, testCase.name));
  });

  app.get('/api/export', async (request, reply) => {
    const format = readFormat(request.query);
    const ordered = suiteOrder(await state.project.listCases());
    if (ordered.length === 0) throw new HttpError(400, 'NO_CASES', 'There are no saved cases to export.');
    const cases: TestCase[] = [];
    for (const item of ordered) cases.push(await state.project.readCase(item.id));
    const docs = await documents(state, cases);
    const settings = await state.project.readSettings();
    const title = `Test cases${settings.appId ? ` for ${settings.appId}` : ''}`;
    return sendExport(state, reply, `test-cases.${format}`, format, await render(state, docs, format, title));
  });
}
