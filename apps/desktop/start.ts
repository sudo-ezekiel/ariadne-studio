// Runs the desktop app from source (`pnpm desktop`). Terminals inside
// Electron-based editors such as VS Code export ELECTRON_RUN_AS_NODE=1, which
// would start Electron as plain Node, so it is removed here.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// From Node, the electron package exports the path of its binary.
const electronBinary = createRequire(import.meta.url)('electron') as string;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], { cwd: here, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
