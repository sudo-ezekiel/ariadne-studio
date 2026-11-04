import type { DefaultTheme } from 'vitepress';
import { DOMAIN } from '../constants.ts';

const nav: DefaultTheme.NavItem[] = [
  {
    text: 'Guides',
    link: '/guides/introduction',
    activeMatch: '^/guides/',
  },
  {
    text: 'FAQ',
    link: '/faq/general',
    activeMatch: '^/faq/',
  },
  {
    text: 'Reference',
    link: '/reference/cli',
    activeMatch: '^/reference/',
  },
  {
    text: 'Contribute',
    link: '/contribute/develop',
    activeMatch: '^/contribute/',
  },
  {
    // The landing page sits outside the docs base, so this link has to be absolute.
    text: 'Landing page',
    link: `${DOMAIN}/`,
    target: '_self',
  },
];

export default nav;
