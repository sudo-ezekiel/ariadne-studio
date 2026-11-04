// The system fonts are the brand's type (docs/brand.md section 4), so the
// default theme is used without its Inter web font.
import DefaultTheme from 'vitepress/theme-without-fonts';
import type { Theme } from 'vitepress';
import './custom.css';

export default {
  extends: DefaultTheme,
} satisfies Theme;
