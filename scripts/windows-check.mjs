// What a first start does on Windows, with no phone attached, for the CI job on
// a real Windows machine. The CLI spawns adb and agent-device's daemon there,
// and neither has been seen working on Windows: under Wine the daemon stalled.
// Starts the built CLI, asks the questions the studio asks when it opens, and
// fails if any stays unanswered.
//   pnpm --filter ariadne-studio build && node scripts/windows-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
/** The daemon's own start-up limit is 60 s. */
const DEVICE_LIST_TIMEOUT_MS = 90_000;

const project = mkdtempSync(join(tmpdir(), 'ariadne-windows-'));
const studio = spawn(process.execPath, [join(root, 'apps/cli/dist/cli.mjs'), project, '--no-open', '--port', String(PORT), '--session', 'windows-check'], { stdio: 'inherit' });

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (studio.exitCode !== null) throw new Error(`The studio exited with ${studio.exitCode}.`);
    try {
      if ((await fetch(`${BASE}/api/session`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The studio did not start within 60 s.');
}

async function ask(path, timeoutMs = 30_000) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${body}`);
  return body;
}

try {
  await waitForServer();
  console.log('[windows-check] the studio is listening');
  const setup = JSON.parse(await ask('/api/setup'));
  console.log(`[windows-check] setup: adb ${setup.adb.found}, maestro ${setup.maestro.found}, java ${setup.java.found}, os ${setup.os}`);
  console.log(`[windows-check] devices: ${await ask('/api/devices', DEVICE_LIST_TIMEOUT_MS)}`);
  const zip = await fetch(`${BASE}/api/diagnostics`);
  if (!zip.ok || (await zip.arrayBuffer()).byteLength === 0) throw new Error('Export diagnostics did not return a file.');
  console.log('[windows-check] PASSED');
} catch (error) {
  console.error(`[windows-check] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  studio.kill();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  process.exit();
}
