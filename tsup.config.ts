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
      // ESM takes import.meta.url first; CJS falls back to its absolute __filename.
      // The order matters because Node 26 exposes a non-absolute `[eval]`
      // __filename during dynamic imports launched from `node -e`.
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
