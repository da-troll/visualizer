import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Canonical nightly-mvp Vite config.
// - base: './'   → relative asset paths so the build works under /YYYY-MM-DD-slug/
// - outDir: 'out' → canonical output dir used by generate-caddyfile.sh
// - react-native-fs alias → stub so jsmediatags (RN-conditional import) builds for web
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      'react-native-fs': fileURLToPath(new URL('./src/stubs/empty.ts', import.meta.url)),
    },
  },
  build: { outDir: 'out', emptyOutDir: true },
});
