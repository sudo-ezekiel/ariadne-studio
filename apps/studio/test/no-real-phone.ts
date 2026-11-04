// Unit tests never reach a real device. Every run asks the phone whether it is a
// Xiaomi, so without this each one would spawn the real adb: slow on Windows,
// and on a developer's machine it could touch a phone that happens to match.
import { vi } from 'vitest';

vi.mock('@ariadne/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@ariadne/core')>();
  return { ...core, phoneInputTools: { ...core.phoneInputTools, xiaomi: async () => undefined } };
});
