import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';
import { BASE, DOMAIN, SHARE_IMAGE } from './config/constants.ts';
import themeConfig from './config/themeConfig.ts';

const title = 'Ariadne';
const description = 'Documentation for Ariadne, a recorder for Maestro: a local Android test recorder that writes plain Maestro YAML.';

export default defineConfig({
  title,
  titleTemplate: ':title | Ariadne',
  description,
  lang: 'en',
  base: BASE,
  // site/ deploys as static files, with the landing page at its root and this build under docs/.
  outDir: '../../site/docs',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: `${DOMAIN}${BASE}` },
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '48x48' }],
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon-192.png', sizes: '192x192' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}icon.svg` }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#1c2b4a' }],
    ['meta', { property: 'og:type', content: 'article' }],
    ['meta', { property: 'og:site_name', content: title }],
    ['meta', { property: 'og:image', content: SHARE_IMAGE }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: SHARE_IMAGE }],
  ],
  // Each page's address and share card, from its own title and description.
  transformPageData(pageData) {
    if (pageData.isNotFound) return;
    const url = `${DOMAIN}${BASE}${pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`;
    const pageTitle = pageData.frontmatter.titleTemplate === false ? pageData.title : `${pageData.title} | ${title}`;
    pageData.frontmatter.head = [
      ...(pageData.frontmatter.head ?? []),
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: pageTitle }],
      ['meta', { property: 'og:description', content: pageData.description }],
      ['meta', { name: 'twitter:title', content: pageTitle }],
      ['meta', { name: 'twitter:description', content: pageData.description }],
    ];
  },
  themeConfig,
  vite: {
    plugins: [
      // The plugin's types resolve to the workspace's Vite 8, while VitePress uses Vite 5.
      llmstxt({
        domain: DOMAIN,
        // The plugin leaves the home page out by default; every page gets a twin here.
        excludeIndexPage: false,
        title,
        description,
        details: 'Ariadne mirrors an Android device on your screen. Every tap, swipe and press becomes a Maestro step with a selector and a screenshot, and the result is a plain Maestro flow. Maestro is a trademark of mobile.dev. Ariadne is an independent tool and is not affiliated with mobile.dev.',
      }) as never,
    ],
  },
});
