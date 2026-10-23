import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  root: path.resolve(__dirname),
  // the bundle's sources live in extension/capture/src: resolve react & friends from this folder's node_modules
  resolve: { alias: { react: path.resolve(__dirname, 'node_modules/react'), 'react-dom': path.resolve(__dirname, 'node_modules/react-dom') } },
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'node' },
  server: { fs: { strict: false } },
})
