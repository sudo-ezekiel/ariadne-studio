// Sets the site's public address everywhere it is written.
//   pnpm site:url https://example.com
// Run `pnpm docs:build` afterwards. The landing page and the docs expect the
// root of a host, so an address with a path is refused.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSTANTS = 'apps/docs/.vitepress/config/constants.ts';
const FILES = [CONSTANTS, 'site/index.html', 'site/robots.txt', 'site/sitemap.xml', 'site/llms.txt', 'README.md', 'apps/cli/package.json'];

let next;
try {
  next = new URL(process.argv[2]);
} catch {
  console.error('Usage: pnpm site:url https://example.com');
  process.exit(2);
}
if (next.protocol !== 'https:' || next.pathname !== '/') {
  console.error(`Expected an https address with no path, not ${process.argv[2]}.`);
  process.exit(2);
}

const current = /export const DOMAIN = 'https:\/\/([^']+)'/.exec(readFileSync(join(root, CONSTANTS), 'utf8'))?.[1];
if (!current) {
  console.error(`No DOMAIN found in ${CONSTANTS}.`);
  process.exit(1);
}
for (const file of FILES) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  // The host, because the README also shows the address as link text.
  writeFileSync(path, text.split(current).join(next.host));
  console.log(`${text.includes(current) ? 'updated' : 'unchanged'} ${file}`);
}
console.log(`The site's address is now ${next.origin}. Run pnpm docs:build.`);
