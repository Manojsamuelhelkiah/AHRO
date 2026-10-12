import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';
import { viteRuntime } from '../../scripts/vite-runtime';
export default defineConfig(async ({ command }) => {
const { port, basePath } = viteRuntime(command, '/uat/');
return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      ...(process.env.VITE_UAT_E2E_AUTH === 'true'
        ? (() => {
          if (command !== 'serve' || process.env.NODE_ENV !== 'test' || process.env.ONBOARDING_E2E_TEST !== 'true') {
            throw new Error('UAT test auth requires an isolated test Vite server');
          }
          return {
            '@clerk/react/internal': path.resolve(import.meta.dirname, 'src/test-support/clerk-auth-adapter.tsx'),
            '@clerk/react': path.resolve(import.meta.dirname, 'src/test-support/clerk-auth-adapter.tsx'),
          };
        })()
        : {}),
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    ...(process.env.VITE_UAT_E2E_AUTH === 'true' ? {
      proxy: { '/uat/api': { target: 'http://127.0.0.1:4178', changeOrigin: false, rewrite: (value: string) => value.replace(/^\/uat/, '') } },
    } : {}),
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
};
});
