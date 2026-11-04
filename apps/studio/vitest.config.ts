import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/no-real-phone.ts'],
    // Windows CI machines are slow enough to pass 5 s on tests that write real files.
    testTimeout: 20_000,
  },
});
