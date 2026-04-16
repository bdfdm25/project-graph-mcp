import Parser from 'tree-sitter';
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { createRequire } from 'module';
import { extname } from 'path';
import { config } from '../config.js';

const require = createRequire(import.meta.url);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedSymbol {
  symbol: string;
  type: 'function' | 'class' | 'interface' | 'variable' | 'export';
  line: number;
}

export interface ParsedImport {
  from: string;        // module specifier as written in source
  line: number;
}

export interface ParsedFile {
  path: string;        // absolute path
  mtime: number;
  hash: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
}

// ─── Grammar loader (lazy, cached) ───────────────────────────────────────────

const grammarCache = new Map<string, Parser>();

function loadGrammar(grammarName: string, ext: string): unknown {
  const raw = require(`tree-sitter-${grammarName}`);
  // tree-sitter-typescript exports { typescript, tsx } — pick by extension
  if (grammarName === 'typescript') {
    return ext === '.tsx' ? raw.tsx : raw.typescript;
  }
  // tree-sitter-javascript and others export the grammar directly
  return raw;
}

function getParser(ext: string): Parser | null {
  if (grammarCache.has(ext)) return grammarCache.get(ext)!;

  const grammarConfig = config.grammars.find((g) => g.extensions.includes(ext));
  if (!grammarConfig) return null;

  try {
    const grammar = loadGrammar(grammarConfig.name, ext);
    const parser = new Parser();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parser.setLanguage(grammar as any);
    grammarCache.set(ext, parser);
    return parser;
  } catch {
    return null;
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function getText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function getLine(node: Parser.SyntaxNode): number {
  return node.startPosition.row + 1;
}

// ─── TypeScript / JavaScript extractor ───────────────────────────────────────

function extractTS(tree: Parser.Tree, src: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case 'import_statement': {
        // import ... from 'module'
        const src_node = node.childrenForFieldName('source')[0];
        if (src_node) {
          const raw = getText(src_node).replace(/^['"]|['"]$/g, '');
          imports.push({ from: raw, line: getLine(node) });
        }
        break;
      }
      case 'function_declaration':
      case 'function': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) symbols.push({ symbol: getText(nameNode), type: 'function', line: getLine(node) });
        break;
      }
      case 'class_declaration':
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) symbols.push({ symbol: getText(nameNode), type: 'class', line: getLine(node) });
        break;
      }
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) symbols.push({ symbol: getText(nameNode), type: 'interface', line: getLine(node) });
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        // const/let/var foo = ...
        for (const child of node.children) {
          if (child.type === 'variable_declarator') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) symbols.push({ symbol: getText(nameNode), type: 'variable', line: getLine(node) });
          }
        }
        break;
      }
      case 'export_statement': {
        // Recurse into the exported declaration
        const decl = node.childForFieldName('declaration');
        if (decl) walk(decl);
        // export { foo, bar }
        const clause = node.children.find((c) => c.type === 'export_clause');
        if (clause) {
          symbols.push({ symbol: getText(clause).replace(/[{}]/g, '').trim(), type: 'export', line: getLine(node) });
        }
        break;
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { symbols, imports };
}

// ─── Python extractor ─────────────────────────────────────────────────────────

function extractPython(tree: Parser.Tree): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) symbols.push({ symbol: getText(nameNode), type: 'function', line: getLine(node) });
        break;
      }
      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) symbols.push({ symbol: getText(nameNode), type: 'class', line: getLine(node) });
        break;
      }
      case 'import_statement': {
        // import foo, bar
        for (const child of node.children) {
          if (child.type === 'dotted_name' || child.type === 'aliased_import') {
            imports.push({ from: getText(child).split(' ')[0], line: getLine(node) });
          }
        }
        break;
      }
      case 'import_from_statement': {
        // from foo import bar
        const modNode = node.childForFieldName('module_name');
        if (modNode) imports.push({ from: getText(modNode), line: getLine(node) });
        break;
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { symbols, imports };
}

// ─── Main parse entry point ───────────────────────────────────────────────────

export function parseFile(filePath: string): ParsedFile | null {
  const ext = extname(filePath);
  const parser = getParser(ext);
  if (!parser) return null;

  let src: string;
  let mtime: number;
  try {
    src = readFileSync(filePath, 'utf-8');
    mtime = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const hash = createHash('sha256').update(src).digest('hex');

  let tree: Parser.Tree;
  try {
    tree = parser.parse(src);
  } catch {
    return null;
  }

  const isPython = ext === '.py';
  const { symbols, imports } = isPython ? extractPython(tree) : extractTS(tree, src);

  return { path: filePath, mtime, hash, symbols, imports };
}
