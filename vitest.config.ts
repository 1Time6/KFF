import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: [{find:/^@kff\/core\/(.*)$/,replacement:path.resolve('packages/core/src')+'/$1'},{find:'@kff/contracts',replacement:path.resolve('packages/contracts/src/index.ts')},{find:'@kff/core',replacement:path.resolve('packages/core/src/index.ts')},{find:'@kff/database',replacement:path.resolve('packages/database/src/index.ts')}] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000, hookTimeout: 30000, fileParallelism: false },
});
