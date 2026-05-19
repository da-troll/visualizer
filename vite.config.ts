import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Canonical nightly-mvp Vite config.
// - base: '/2026-05-19-visualizer/' → absolute prefix so module-script MIME checks pass
//   when the URL is loaded with no trailing slash or with a query string. Relative
//   './' broke under cache-buster URLs because the browser resolved asset paths
//   from the WRONG base and Caddy served index.html as fallback → MIME type error.
// - outDir: 'out' → canonical output dir Caddy serves from
// - react-native-fs alias → stub so jsmediatags (RN-conditional import) builds for web
export default defineConfig({
  plugins: [react()],
  base: '/2026-05-19-visualizer/',
  resolve: {
    alias: {
      'react-native-fs': fileURLToPath(new URL('./src/stubs/empty.ts', import.meta.url)),
    },
  },
  build: { outDir: 'out', emptyOutDir: true },
});
