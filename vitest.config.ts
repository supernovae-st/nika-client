import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Local evidence may contain archived source trees, not SDK test suites.
    exclude: [...configDefaults.exclude, '**/.local/**'],
  },
});
