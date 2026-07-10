import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/local/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
});
