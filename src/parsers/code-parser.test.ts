import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseFile } from './code-parser.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pgmcp-code-'));

function writeFixture(name: string, content: string): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('parseFile', () => {
  it('returns null for unknown extension', () => {
    const p = writeFixture('file.txt', 'hello');
    expect(parseFile(p)).toBeNull();
  });

  it('returns null for non-existent file', () => {
    expect(parseFile('/no/such/file.ts')).toBeNull();
  });

  describe('TypeScript', () => {
    it('extracts named imports', () => {
      const p = writeFixture('imports.ts', `import { foo, bar } from './utils.js';`);
      const r = parseFile(p)!;
      expect(r.imports).toContainEqual(expect.objectContaining({ from: './utils.js' }));
    });

    it('extracts default import', () => {
      const p = writeFixture('default.ts', `import React from 'react';`);
      const r = parseFile(p)!;
      expect(r.imports).toContainEqual(expect.objectContaining({ from: 'react' }));
    });

    it('extracts function declaration as symbol', () => {
      const p = writeFixture('func.ts', `function greet(name: string) { return name; }`);
      const r = parseFile(p)!;
      expect(r.symbols).toContainEqual(expect.objectContaining({ symbol: 'greet', type: 'function' }));
    });

    it('extracts class declaration as symbol', () => {
      const p = writeFixture('class.ts', `class MyService {}`);
      const r = parseFile(p)!;
      expect(r.symbols).toContainEqual(expect.objectContaining({ symbol: 'MyService', type: 'class' }));
    });

    it('extracts interface declaration as symbol', () => {
      const p = writeFixture('iface.ts', `interface UserDto { id: string; }`);
      const r = parseFile(p)!;
      expect(r.symbols).toContainEqual(expect.objectContaining({ symbol: 'UserDto', type: 'interface' }));
    });

    it('extracts variable declaration as symbol', () => {
      const p = writeFixture('var.ts', `const myConst = 42;`);
      const r = parseFile(p)!;
      expect(r.symbols).toContainEqual(expect.objectContaining({ symbol: 'myConst', type: 'variable' }));
    });

    it('returns path, mtime, and hash on result', () => {
      const p = writeFixture('meta.ts', `const x = 1;`);
      const r = parseFile(p)!;
      expect(r.path).toBe(p);
      expect(r.mtime).toBeGreaterThan(0);
      expect(r.hash).toHaveLength(64);
    });

    it('returns same hash for identical content', () => {
      const src = `const x = 1;`;
      const p1 = writeFixture('hash1.ts', src);
      const p2 = writeFixture('hash2.ts', src);
      expect(parseFile(p1)!.hash).toBe(parseFile(p2)!.hash);
    });

    it('returns null on syntax error gracefully', () => {
      // tree-sitter is error-resilient, so we expect a result (possibly empty symbols)
      // but no thrown exception
      const p = writeFixture('broken.ts', `function ({{{`);
      expect(() => parseFile(p)).not.toThrow();
    });

    it('extracts named export clause symbols', () => {
      const p = writeFixture('export-clause.ts', `const a = 1;\nconst b = 2;\nexport { a, b };`);
      const r = parseFile(p)!;
      expect(r.symbols.some((s) => s.type === 'export')).toBe(true);
    });
  });

  describe('Python', () => {
    it('extracts import statement', () => {
      const p = writeFixture('imports.py', `import os\nimport sys`);
      const r = parseFile(p)!;
      expect(r.imports).toContainEqual(expect.objectContaining({ from: 'os' }));
      expect(r.imports).toContainEqual(expect.objectContaining({ from: 'sys' }));
    });

    it('extracts from-import statement', () => {
      const p = writeFixture('from.py', `from pathlib import Path`);
      const r = parseFile(p)!;
      expect(r.imports).toContainEqual(expect.objectContaining({ from: 'pathlib' }));
    });

    it('extracts function definition', () => {
      const p = writeFixture('func.py', `def my_function(x):\n    return x`);
      const r = parseFile(p)!;
      expect(r.symbols).toContainEqual(expect.objectContaining({ symbol: 'my_function', type: 'function' }));
    });

    it('extracts class definition', () => {
      const p = writeFixture('cls.py', `class MyClass:\n    pass`);
      const r = parseFile(p)!;
      expect(r.symbols).toContainEqual(expect.objectContaining({ symbol: 'MyClass', type: 'class' }));
    });
  });
});
