import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@configs': path.resolve(__dirname, 'src/configs'),
      '@assets': path.resolve(__dirname, 'src/assets'),
      '@core': path.resolve(__dirname, 'src/@core'),
      '@menu': path.resolve(__dirname, 'src/@menu'),
      '@layouts': path.resolve(__dirname, 'src/@layouts'),
      '@views': path.resolve(__dirname, 'src/views'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,js}'],
    // Spin a per-run Postgres schema, apply Prisma migrations, drop on exit.
    // Tests that need DB access import `{ prismaTest, truncate }` from
    // src/__tests__/setup/prisma-test.ts. Tests that don't (pure-logic
    // ones like network.test.ts / ipamScan.test.ts) keep working unchanged.
    globalSetup: ['./src/__tests__/setup/postgres.ts'],
    // Tests share a single Postgres schema and reset state via TRUNCATE in
    // beforeEach; running them in parallel makes them step on each other's
    // rows. fileParallelism=false serializes the test files (each file's
    // `it`s still run sequentially within it) and keeps the suite fast
    // enough for the size we have today.
    fileParallelism: false,
    // Coverage config used by `npm run test:coverage`. The Sonar workflow
    // runs this before the scan and the lcov output below is picked up via
    // sonar.javascript.lcov.reportPaths in sonar-project.properties.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // Cover application source only. Test files, vendored template code
      // (@core / @menu / @layouts) and generated Prisma output should not
      // dilute the percentage.
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx,js,jsx}',
        'src/__tests__/**',
        'src/@core/**',
        'src/@menu/**',
        'src/@layouts/**',
        'src/types/**',
        '**/*.d.ts',
      ],
    },
  },
})
