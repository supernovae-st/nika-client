import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    target: 'es2022',
    splitting: false,
    esbuildOptions(options) {
      // CJS takes the __filename branch; import.meta.url is used only by ESM.
      options.logOverride = { 'empty-import-meta': 'silent' };
    },
  },
  {
    entry: { 'bin/nika': 'src/bin/nika.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'es2022',
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
