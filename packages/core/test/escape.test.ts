import { describe, expect, it } from 'vitest';
import { escapeMaestroRegex, unescapeMaestroRegex } from '../src/maestro/escape.ts';

describe('escapeMaestroRegex', () => {
  it('escapes every regex metacharacter Maestro would interpret', () => {
    expect(escapeMaestroRegex('. * + ? ^ $ { } ( ) | [ ] \\')).toBe(
      '\\. \\* \\+ \\? \\^ \\$ \\{ \\} \\( \\) \\| \\[ \\] \\\\',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(escapeMaestroRegex('Network & internet')).toBe('Network & internet');
    expect(escapeMaestroRegex('android:id/title')).toBe('android:id/title');
  });

  it('produces a pattern that matches the original literally', () => {
    for (const value of ['Storage (64 GB)', 'Price: $9.99+tax', 'a|b', 'com.android.settings:id/title', '[beta] ^v2$']) {
      const pattern = new RegExp(`^(?:${escapeMaestroRegex(value)})$`);
      expect(pattern.test(value)).toBe(true);
      expect(unescapeMaestroRegex(escapeMaestroRegex(value))).toBe(value);
    }
  });
});
