import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type UserConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

import { viteRuntime } from '../../scripts/vite-runtime';

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const { port, basePath } = viteRuntime(command, '/');
  const browserRegressionRequested =
    process.env.VITE_E2E_TEST_AUTH === 'true';
  const browserRegression =
    browserRegressionRequested &&
    command === 'serve' &&
    process.env.NODE_ENV === 'test' &&
    process.env.ONBOARDING_E2E_TEST === 'true';
  if (browserRegressionRequested && !browserRegression) {
    throw new Error(
      'VITE_E2E_TEST_AUTH requires a Vite dev server with NODE_ENV=test and ONBOARDING_E2E_TEST=true',
    );
  }
  const e2eApiOrigin = process.env.E2E_API_ORIGIN || 'http://127.0.0.1:4178';
  if (browserRegression) {
    const apiUrl = new URL(e2eApiOrigin);
    if (
      apiUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname)
    ) {
      throw new Error(
        'Browser regression API proxy must target an HTTP loopback origin',
      );
    }
  }
  const e2eAuthAdapter = path.resolve(
    import.meta.dirname,
    'src',
    'test-support',
    'clerk-auth-adapter.tsx',
  );
  return {
  base: basePath,
  // The isolated auth-adapter server may run beside the real Clerk preview.
  // Never let their different dependency graphs overwrite the same optimizer cache.
  cacheDir: path.resolve(import.meta.dirname, 'node_modules',
    browserRegression ? '.vite-browser-regression' : '.vite'),
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
    alias: [
      ...(browserRegression
        ? [
            {
              find: '@clerk/react/internal',
              replacement: e2eAuthAdapter,
            },
            { find: '@clerk/react', replacement: e2eAuthAdapter },
          ]
        : []),
      { find: '@', replacement: path.resolve(import.meta.dirname, 'src') },
      {
        find: '@assets',
        replacement: path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: browserRegression ? '127.0.0.1' : '0.0.0.0',
    allowedHosts: browserRegression ? ['127.0.0.1', 'localhost'] : true,
    ...(browserRegression
      ? {
          proxy: {
            '/api': {
              target: e2eApiOrigin,
              // Same-site admin writes must see the browser-facing host, not
              // the loopback upstream port. This proxy is test-only.
              changeOrigin: false,
            },
          },
        }
      : {}),
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: browserRegression ? '127.0.0.1' : '0.0.0.0',
    allowedHosts: browserRegression ? ['127.0.0.1', 'localhost'] : true,
  },
  };
});
