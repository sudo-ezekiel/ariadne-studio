// A lenient reader for developer-written blocks. parseMaestroFlow stays strict
// for case flows; a block may use any Maestro command, and the ones outside
// the subset make the studio run the block with the Maestro CLI instead of
// agent-device. Only text that is not a Maestro flow at all is refused.
import { parseAllDocuments } from 'yaml';
import { flowVariables, type MaestroFlow, type MaestroStep } from './model.ts';
import { MaestroParseError, parseMaestroFlow, parseStep } from './parse.ts';

/** One command of a block: read by Ariadne, or left for Maestro (named by its command). */
export type BlockCommand = { kind: 'step'; step: MaestroStep } | { kind: 'maestro'; command: string };

export type BlockOutline = {
  appId: string;
  name?: string;
  env?: Record<string, string>;
  commands: BlockCommand[];
  /**
   * Commands and header keys outside Ariadne's subset, in order and without
   * repeats, e.g. ["runScript", "onFlowStart"]. Empty when `flow` is set.
   */
  maestroOnly: string[];
  /** ${KEY} variables the block uses anywhere, including commands Ariadne does not read. */
  variables: string[];
  /** The whole block, when Ariadne's own parser reads every command and key. */
  flow?: MaestroFlow;
  /**
   * This file on its own, when Ariadne's parser reads all of it. Unlike `flow`
   * it stays set when a step or a file it runs sends the block to Maestro, so
   * it says whether the Blocks tab can edit the file.
   */
  ownFlow?: MaestroFlow;
};

const HEADER_KEYS = ['appId', 'name', 'env'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromFlow(flow: MaestroFlow): BlockOutline {
  return {
    appId: flow.appId,
    ...(flow.name !== undefined ? { name: flow.name } : {}),
    ...(flow.env ? { env: flow.env } : {}),
    commands: flow.steps.map((step) => ({ kind: 'step', step })),
    maestroOnly: [],
    variables: flowVariables(flow),
    flow,
    ownFlow: flow,
  };
}

/**
 * Reads a block. Throws MaestroParseError only when the text is not a
 * Maestro flow: invalid YAML, no header and command list, no appId, or a
 * command that is not a single string or one-key mapping.
 */
export function parseBlockFlow(yamlText: string): BlockOutline {
  try {
    return fromFlow(parseMaestroFlow(yamlText));
  } catch (error) {
    if (!(error instanceof MaestroParseError)) throw error;
  }
  const docs = parseAllDocuments(yamlText);
  if (!Array.isArray(docs)) throw new MaestroParseError('Not a YAML document stream');
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new MaestroParseError(doc.errors[0]!.message);
  }
  if (docs.length !== 2) throw new MaestroParseError('A flow needs a header, a "---" line, then a list of commands');
  const header: unknown = docs[0]!.toJS();
  const body: unknown = docs[1]!.toJS();
  if (!isRecord(header)) throw new MaestroParseError('The flow header must be a mapping');
  if (typeof header.appId !== 'string') throw new MaestroParseError('appId must be a string');
  if (body !== null && !Array.isArray(body)) throw new MaestroParseError('The flow body must be a list of commands');
  const raw: unknown[] = body ?? [];

  const maestroOnly = new Set<string>(Object.keys(header).filter((key) => !HEADER_KEYS.includes(key)));
  const commands = raw.map((item, position): BlockCommand => {
    let command: string;
    if (typeof item === 'string') command = item;
    else if (isRecord(item) && Object.keys(item).length === 1) command = Object.keys(item)[0]!;
    else throw new MaestroParseError(`step ${position + 1} must be a single command`);
    try {
      return { kind: 'step', step: parseStep(item, position) };
    } catch (error) {
      if (!(error instanceof MaestroParseError)) throw error;
      maestroOnly.add(command);
      return { kind: 'maestro', command };
    }
  });

  const outline: BlockOutline = {
    appId: header.appId,
    commands,
    maestroOnly: [...maestroOnly],
    // flowVariables only stringifies `steps`; hooks such as onFlowStart can use variables too.
    variables: flowVariables({ steps: [raw, header] as unknown as MaestroStep[] }),
  };
  if (typeof header.name === 'string') outline.name = header.name;
  if (header.env !== undefined) {
    if (!isRecord(header.env)) throw new MaestroParseError('env must be a mapping');
    outline.env = Object.fromEntries(Object.entries(header.env).map(([key, value]) => [key, String(value)]));
  }
  return outline;
}
