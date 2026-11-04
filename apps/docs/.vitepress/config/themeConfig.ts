import type { DefaultTheme } from 'vitepress';
import { TRADEMARK_LINE } from './constants.ts';
import nav from './navigation/navbar.ts';
import sidebar from './navigation/sidebar.ts';

const themeConfig: DefaultTheme.Config = {
  logo: {
    src: '/icon.svg',
    width: 24,
    height: 24,
    alt: '',
  },

  nav,
  sidebar,

  outline: [2, 3],

  footer: {
    message: TRADEMARK_LINE,
  },

  lastUpdated: {
    text: 'Last updated',
    formatOptions: {
      dateStyle: 'long',
    },
  },

  search: {
    provider: 'local',
  },
};

export default themeConfig;
