// Checks the built site before a launch. Run `pnpm docs:build` first.
//   pnpm seo:check          fails on anything a crawler would trip over
//   pnpm seo:check --draft  the same, while the address is still the placeholder
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const draft = process.argv.includes('--draft');
const domain = /export const DOMAIN = '([^']+)'/.exec(readFileSync(join(root, 'apps/docs/.vitepress/config/constants.ts'), 'utf8'))[1];
const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

function pagesIn(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'assets' ? [] : pagesIn(path);
    return name.endsWith('.html') && name !== '404.html' ? [path] : [];
  });
}

const addressOf = (file) => `${domain}/${relative(site, file).replace(/\\/g, '/').replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
const attr = (html, pattern) => pattern.exec(html)?.[1];
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
const plain = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// The file the host serves for a path, the way html_handling auto-trailing-slash does:
// x/ is x/index.html, x is x.html or x/index.html, and a real file is itself.
const isFile = (path) => existsSync(path) && statSync(path).isFile();
function fileFor(pathname) {
  const path = join(site, pathname);
  if (relative(site, path).startsWith('..')) return undefined;
  if (pathname.endsWith('/')) return isFile(join(path, 'index.html')) ? join(path, 'index.html') : undefined;
  return [path, `${path}.html`, join(path, 'index.html')].find(isFile);
}
const ids = new Map();
const idsIn = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]*)"/g)].map((match) => decode(match[1]))));
  return ids.get(file);
};
const origin = new URL(domain).origin;

// Every link into the site reaches a page, and its #fragment an element on that page.
function checkLinks(file, html, where) {
  const markup = html.replace(/<(template|script)\b[\s\S]*?<\/\1>/g, '');
  for (const [, raw] of markup.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
    const href = decode(raw);
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^https?:/i.test(href)) continue;
    const target = new URL(href, addressOf(file));
    if (target.origin !== origin) continue;
    const page = fileFor(decodeURIComponent(target.pathname));
    if (!page) {
      problem(where, `link ${href} has no page`);
      continue;
    }
    const id = decodeURIComponent(target.hash.slice(1));
    if (id && !idsIn(page).has(id)) problem(where, `link ${href}: no id "${id}" in ${relative(site, page)}`);
  }
}

const titles = new Map();
const descriptions = new Map();
const pages = pagesIn(site);

for (const file of pages) {
  const where = relative(site, file);
  const html = readFileSync(file, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));

  const title = decode(attr(head, /<title>([^<]*)<\/title>/) ?? '');
  if (title.length < 10 || title.length > 65) problem(where, `title is ${title.length} characters: "${title}"`);
  if (titles.has(title)) problem(where, `same title as ${titles.get(title)}: "${title}"`);
  titles.set(title, where);

  const description = decode(attr(head, /<meta name="description" content="([^"]*)"/) ?? '');
  if (description.length < 70 || description.length > 160) problem(where, `description is ${description.length} characters`);
  if (descriptions.has(description)) problem(where, `same description as ${descriptions.get(description)}`);
  descriptions.set(description, where);

  const canonical = attr(head, /<link rel="canonical" href="([^"]*)"/);
  if (canonical !== addressOf(file)) problem(where, `canonical is ${canonical}, expected ${addressOf(file)}`);

  for (const property of ['og:title', 'og:description', 'og:image', 'og:url']) {
    if (!new RegExp(`<meta property="${property}" content="[^"]+"`).test(head)) problem(where, `no ${property}`);
  }
  if (!/<meta name="twitter:card"/.test(head)) problem(where, 'no twitter:card');

  const headings = html.match(/<h1[\s>]/g)?.length ?? 0;
  if (headings !== 1) problem(where, `${headings} h1 headings`);
  for (const image of html.match(/<img\b[^>]*>/g) ?? []) {
    if (!/\balt[\s=>]/.test(image)) problem(where, `image without alt: ${image.slice(0, 80)}`);
  }
  checkLinks(file, html, where);

  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((match) => {
    try {
      return [JSON.parse(match[1])];
    } catch {
      problem(where, 'structured data is not valid JSON');
      return [];
    }
  });
  // Google's rule: mark up only what readers can see.
  const faq = structured.find((item) => item['@type'] === 'FAQPage');
  if (faq) {
    const shown = new Map([...html.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<div class="answer">([\s\S]*?)<\/div>/g)].map((match) => [plain(match[1]), plain(match[2])]));
    const marked = faq.mainEntity.map((item) => item.name);
    if (marked.length !== shown.size) problem(where, `${marked.length} questions marked up, ${shown.size} on the page`);
    for (const item of faq.mainEntity) {
      if (!shown.has(item.name)) problem(where, `marked-up question is not on the page: ${item.name}`);
      else if (shown.get(item.name) !== item.acceptedAnswer.text) problem(where, `marked-up answer differs from the page: ${item.name}`);
    }
  }
}

// Every page is listed, and every listed address is a real page.
const listed = new Set();
const robots = readFileSync(join(site, 'robots.txt'), 'utf8');
for (const [, url] of robots.matchAll(/^Sitemap: (\S+)$/gm)) {
  const file = join(site, url.slice(domain.length));
  if (!url.startsWith(domain) || !existsSync(file)) {
    problem('robots.txt', `sitemap ${url} does not exist`);
    continue;
  }
  for (const [, loc] of readFileSync(file, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) listed.add(loc);
}
const addresses = new Set(pages.map(addressOf));
for (const address of addresses) if (!listed.has(address)) problem('sitemap', `${address} is missing`);
for (const address of listed) if (!addresses.has(address)) problem('sitemap', `${address} is not a page`);

if (!draft && domain === 'https://ariadne.example') problem('address', 'still the placeholder: run pnpm site:url https://...');

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problems in ${pages.length} pages.`);
  process.exit(1);
}
console.log(`${pages.length} pages and ${listed.size} sitemap addresses are clean.`);
