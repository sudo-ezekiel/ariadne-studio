// Development entry for `pnpm dev` and `pnpm start`. Kept apart from index.ts
// so that importing the server (tests, the CLI bundle) never starts one.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, startStudio } from './index.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function projectDirFromArgs(): string {
  const arg = process.argv[2] ?? process.env.ARIADNE_PROJECT_DIR;
  // pnpm runs scripts from the package directory; resolve user paths against
  // the directory pnpm was started in instead.
  if (arg) return resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  return resolve(repoRoot, 'workspace');
}

async function main(): Promise<void> {
  const projectDir = projectDirFromArgs();
  // A second studio on the same machine needs its own agent-device session.
  const sessionName = process.env.ARIADNE_SESSION_NAME?.trim() || 'studio';
  const studio = await startStudio({
    projectDir,
    sessionName,
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    host: process.env.HOST ?? '127.0.0.1',
  });
  const shutdown = async (signal: string) => {
    console.log(`[studio] ${signal}: closing device session`);
    await studio.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  console.log(`[studio] project ${projectDir}`);
  console.log(`[studio] API on ${studio.url}${studio.servesUi ? ' (serving built UI)' : ''}`);
}

main().catch((error: unknown) => {
  console.error('[studio] failed to start:', error);
  process.exit(1);
});
