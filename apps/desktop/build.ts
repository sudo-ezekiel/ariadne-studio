// `tsx build.ts` bundles the Electron main process into dist/main.cjs.
// `tsx build.ts --stage` copies what the packaged app runs as its server into
// stage/server: the CLI bundle with its UI, and agent-device as a real folder
// (pnpm keeps it behind a symlink, which electron-builder would not follow).
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, '../cli');

async function bundleMain(): Promise<void> {
  await build({
    entryPoints: [join(here, 'src/main.ts')],
    outfile: join(here, 'dist/main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
  });
  console.log(`Built ${join(here, 'dist/main.cjs')}`);
}

function stageServer(): void {
  if (!existsSync(join(cliDir, 'dist/cli.mjs'))) {
    console.error('The CLI is not built. Run `pnpm build` at the repository root first.');
    process.exit(1);
  }
  const stage = join(here, 'stage/server');
  rmSync(join(here, 'stage'), { recursive: true, force: true });
  cpSync(join(cliDir, 'dist'), join(stage, 'dist'), { recursive: true });
  cpSync(join(cliDir, 'package.json'), join(stage, 'package.json'));

  // Every runtime dependency of the CLI, copied as real files. agent-device has no dependencies of its own.
  const cliPackage = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(cliPackage.dependencies ?? {})) {
    // Not require.resolve: agent-device's "exports" does not expose package.json.
    const source = realpathSync(join(cliDir, 'node_modules', name));
    cpSync(source, join(stage, 'node_modules', name), {
      recursive: true,
      dereference: true,
      filter: (path) => !path.slice(source.length).split(/[\\/]/).includes('node_modules'),
    });
  }
  console.log(`Staged the studio server in ${stage}`);
}

if (process.argv.includes('--stage')) stageServer();
else await bundleMain();
