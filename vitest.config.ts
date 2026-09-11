import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@kff/contracts': path.resolve('packages/contracts/src/index.ts'), '@kff/core': path.resolve('packages/core/src/index.ts'), '@kff/database': path.resolve('packages/database/src/index.ts') } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000, hookTimeout: 30000, fileParallelism: false },
});
