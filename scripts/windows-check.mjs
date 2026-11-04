// What a first start does on Windows, with no phone attached, for the CI job on
// a real Windows machine. The CLI spawns adb and agent-device's daemon there,
// and the daemon can stall at start: under Wine it always did.
// Starts the built CLI, asks the questions the studio asks when it opens, and
// fails if any stays unanswered.
//   pnpm --filter ariadne-studio build && node scripts/windows-check.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
/** The daemon's own start-up limit is 60 s. */
const DEVICE_LIST_TIMEOUT_MS = 90_000;
/** It stalled on one Windows machine in four, so one failure says less than what the next try does. */
const DEVICE_LIST_ATTEMPTS = 3;

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

/** What agent-device wrote about its own start, the only record of where a stall happened. */
function printDaemonLogs() {
  const dir = join(homedir(), '.agent-device');
  if (!existsSync(dir)) return;
  const logs = readdirSync(dir, { recursive: true }).map(String).filter((name) => /daemon.*(log|jsonl)$/.test(name));
  for (const name of logs) {
    console.log(`[windows-check] --- ${name}`);
    console.log(readFileSync(join(dir, name), 'utf8').split(/\r?\n/).slice(-40).join('\n'));
  }
}

async function listDevices() {
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    try {
      const devices = await ask('/api/devices', DEVICE_LIST_TIMEOUT_MS);
      console.log(`[windows-check] devices on attempt ${attempt} after ${Date.now() - started} ms: ${devices}`);
      return;
    } catch (error) {
      console.log(`[windows-check] attempt ${attempt} failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`);
      printDaemonLogs();
      if (attempt === DEVICE_LIST_ATTEMPTS) throw error;
    }
  }
}

try {
  await waitForServer();
  console.log('[windows-check] the studio is listening');
  const setup = JSON.parse(await ask('/api/setup'));
  console.log(`[windows-check] setup: adb ${setup.adb.found}, maestro ${setup.maestro.found}, java ${setup.java.found}, os ${setup.os}`);
  await listDevices();
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
