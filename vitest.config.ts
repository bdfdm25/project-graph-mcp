import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // tools.ts requires integration coverage — excluded from threshold gate
      include: [
        'src/graph/algorithms.ts',
        'src/vault/writer.ts',
        'src/parsers/vault-parser.ts',
        'src/parsers/code-parser.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
