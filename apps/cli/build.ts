// Bundles the CLI and the studio server into dist/cli.mjs and copies the built
// UI next to it. Everything is inlined except the packages listed in
// "dependencies": agent-device reads its own files (helper APKs, its daemon
// entry) relative to its install folder, so it has to stay a real package.
import { builtinModules, createRequire } from 'node:module';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const studioUi = join(here, '../studio/dist/ui');

type PackageJson = { name: string; version?: string; license?: string; dependencies?: Record<string, string> };
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as PackageJson;
const runtimeDependencies = Object.keys(pkg.dependencies ?? {});

if (!existsSync(join(studioUi, 'index.html'))) {
  console.error(`The studio UI is not built (${studioUi}). Run \`pnpm build\` at the repository root.`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

const result = await build({
  entryPoints: [join(here, 'src/cli.ts')],
  outfile: join(dist, 'cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  external: runtimeDependencies,
  // Bundled CommonJS packages (fastify and friends) call require() for Node
  // builtins, which an ES module does not have.
  banner: { js: "import { createRequire as __ariadneCreateRequire } from 'node:module';\nconst require = __ariadneCreateRequire(import.meta.url);" },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// Every bare import left in the bundle must be installable from "dependencies".
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const externalImports = new Set<string>();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && !builtins.has(imported.path)) externalImports.add(imported.path);
  }
}
const missing = [...externalImports].filter(
  (path) => !runtimeDependencies.some((dep) => path === dep || path.startsWith(`${dep}/`)),
);
if (missing.length > 0) {
  console.error(`The bundle imports packages that are not in dependencies: ${missing.join(', ')}`);
  process.exit(1);
}

cpSync(studioUi, join(dist, 'ui'), { recursive: true });

// Run videos need the font and resvg's WebAssembly as files; they do not bundle.
cpSync(join(here, '../studio/assets/run-video'), join(dist, 'run-video'), { recursive: true });
cpSync(
  createRequire(join(here, '../studio/package.json')).resolve('@resvg/resvg-wasm/index_bg.wasm'),
  join(dist, 'run-video/index_bg.wasm'),
);

// Ariadne's own licence, which sits at the repository root and so would not reach the package.
cpSync(join(here, '../../LICENSE'), join(dist, 'LICENSE'));

// The bundle carries code from these packages, so their licence texts ship with it.
function packageRoot(inputPath: string): string | undefined {
  const marker = 'node_modules/';
  const at = inputPath.lastIndexOf(marker);
  if (at === -1) return undefined;
  const rest = inputPath.slice(at + marker.length).split('/');
  const nameParts = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  return inputPath.slice(0, at + marker.length) + nameParts.join('/');
}

const roots = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const root = packageRoot(input);
  if (root) roots.add(root);
}
// The UI bundle (built by Vite) carries React, which esbuild never saw.
const fromStudio = createRequire(join(here, '../studio/package.json'));
const reactDom = dirname(fromStudio.resolve('react-dom/package.json'));
roots.add(dirname(fromStudio.resolve('react/package.json')));
roots.add(reactDom);
roots.add(dirname(createRequire(join(reactDom, 'package.json')).resolve('scheduler/package.json')));

/** Packages that ship no licence file: where their licence and source are. */
const NO_LICENCE_FILE: Record<string, string> = {
  '@resvg/resvg-wasm': 'Mozilla Public License 2.0: https://www.mozilla.org/en-US/MPL/2.0/\nSource: https://github.com/yisibl/resvg-js',
  'abstract-logging': 'MIT License: https://opensource.org/license/mit\nSource: https://github.com/jsumners/abstract-logging',
};

const notices: string[] = [];
for (const root of [...roots].sort()) {
  const absolute = isAbsolute(root) ? root : join(process.cwd(), root);
  const meta = JSON.parse(readFileSync(join(absolute, 'package.json'), 'utf8')) as PackageJson;
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'].map((file) => join(absolute, file)).find(existsSync);
  notices.push(
    `${meta.name}@${meta.version ?? ''} (${meta.license ?? 'see package'})\n\n${licenseFile ? readFileSync(licenseFile, 'utf8').trim() : (NO_LICENCE_FILE[meta.name] ?? 'No licence file in the package.')}`,
  );
}
writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), `${notices.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`);

const size = (readFileSync(join(dist, 'cli.mjs')).length / 1024).toFixed(0);
console.log(`Built ${join(dist, 'cli.mjs')} (${size} KiB), the UI and ${notices.length} licence notices.`);
