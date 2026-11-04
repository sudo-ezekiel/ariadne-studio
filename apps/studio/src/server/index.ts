import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { DeviceSession, ProjectStore, androidHome, findMaestro, phoneInputTools, runMaestro, type PhoneInputTools } from '@ariadne/core';
import { stopPhoneCapture } from './phone-capture.ts';
import { registerDiagnosticsRoutes } from './diagnostics.ts';
import { fromThisComputer } from './local-only.ts';
import { captureLog, type LogBuffer } from './log-buffer.ts';
import { registerRoutes } from './routes.ts';
import { findFfmpeg, frameRunVideo } from './run-video.ts';
import { defaultSetupTools, registerSetupRoutes, type SetupTools } from './setup.ts';
import { createState, type DeviceLike, type MaestroTools } from './state.ts';

export const DEFAULT_PORT = 4711;

/** Where `vite build` puts the UI; a bundled server passes its own `uiDir`. */
const uiDist = fileURLToPath(new URL('../../dist/ui/', import.meta.url));

/** A replay that has not finished after this long is stopped and reported as failed. */
const REPLAY_TIMEOUT_MS = 5 * 60_000;

export type BuildServerOptions = {
  projectDir: string;
  session?: DeviceLike;
  /** agent-device session name when `session` is not given; default "studio". */
  sessionName?: string;
  /** Replaces parts of the Maestro CLI integration, for tests. */
  maestro?: Partial<MaestroTools>;
  /** Replaces the programs the device setup guide runs, for tests. */
  setup?: Partial<SetupTools>;
  /** Replaces what recording from the phone asks of adb, for tests. */
  phoneTools?: Partial<PhoneInputTools>;
  /** The version a diagnostics report names; the CLI and the desktop app pass their own. */
  appVersion?: string;
  /** Where the end of the studio's log is kept, for a diagnostics report. */
  log?: LogBuffer;
  /** The address the server listens on, to tell who may call the API. */
  listenHost?: string;
  /** Built UI to serve on `/`; default apps/studio/dist/ui. Nothing is served when it does not exist. */
  uiDir?: string;
  /** Fonts and rasteriser for run videos; a bundled server passes its own, default apps/studio/assets/run-video. */
  videoAssetsDir?: string;
};

/** Builds the app without listening, so tests can drive it with inject(). */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const project = await ProjectStore.open(options.projectDir);
  const session = options.session ?? new DeviceSession({ sessionName: options.sessionName ?? 'studio', cwd: project.dir });
  const maestro: MaestroTools = {
    run: runMaestro,
    findBin: findMaestro,
    androidHome,
    timeoutMs: REPLAY_TIMEOUT_MS,
    findFfmpeg,
    frameVideo: (input) => frameRunVideo({ ...input, ...(options.videoAssetsDir ? { assetsDir: options.videoAssetsDir } : {}) }),
    ...options.maestro,
  };
  const state = await createState(project, session, maestro, { ...phoneInputTools, ...options.phoneTools });
  if (options.log) state.log = options.log;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  const listenHost = options.listenHost ?? '127.0.0.1';
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || fromThisComputer(request.headers, listenHost)) return;
    return reply.status(403).send({ error: { code: 'NOT_THIS_COMPUTER', message: 'This request did not come from Ariadne on this computer.' } });
  });

  // One line per request with timing; device actions take seconds, so this is
  // the first place to look when the studio feels slow.
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/screen/image') || request.url.startsWith('/api/screen/refresh') || request.url.startsWith('/api/evidence/')) return;
    if (request.url.startsWith('/api/runs/')) return;
    if (!request.url.startsWith('/api/')) return;
    console.log(
      `[studio] ${request.method} ${request.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`,
    );
  });

  registerRoutes(app, state);
  const setup = { ...defaultSetupTools(maestro.androidHome, maestro.findBin), ...options.setup };
  registerSetupRoutes(app, setup);
  registerDiagnosticsRoutes(app, state, { appVersion: options.appVersion ?? 'development', setup });

  const uiDir = options.uiDir ?? uiDist;
  if (existsSync(uiDir)) {
    await app.register(fastifyStatic, { root: uiDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route ${request.url}` } });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    await stopPhoneCapture(state).catch(() => undefined);
    if (state.session.isOpen) await state.session.close().catch(() => undefined);
    // The live screenshot's folder in the system temp directory.
    await rm(state.scratchDir, { recursive: true, force: true }).catch(() => undefined);
  });
  return app;
}

export type StartStudioOptions = BuildServerOptions & {
  /** 0 picks a free port. */
  port?: number;
  host?: string;
};

export type RunningStudio = {
  app: FastifyInstance;
  /** Address the UI is served on, e.g. http://127.0.0.1:4711. */
  url: string;
  port: number;
  projectDir: string;
  servesUi: boolean;
  close(): Promise<void>;
};

/** The address a browser should open for a server listening on host and port. */
export function studioUrl(host: string, port: number): string {
  // Browsers cannot open 0.0.0.0 or ::, so point them at this machine instead.
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

/** Builds the server and listens. Used by `pnpm start`, the npm CLI and the desktop app. */
export async function startStudio(options: StartStudioOptions): Promise<RunningStudio> {
  const log = captureLog();
  const app = await buildServer({ ...options, log, listenHost: options.host ?? '127.0.0.1' });
  const host = options.host ?? '127.0.0.1';
  try {
    await app.listen({ port: options.port ?? DEFAULT_PORT, host });
  } catch (error) {
    await app.close().catch(() => undefined);
    log.stop();
    throw error;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_PORT);
  return {
    app,
    url: studioUrl(host, port),
    port,
    projectDir: resolve(options.projectDir),
    servesUi: existsSync(options.uiDir ?? uiDist),
    close: async () => {
      await app.close();
      log.stop();
    },
  };
}
