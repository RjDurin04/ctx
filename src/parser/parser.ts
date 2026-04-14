import Parser from "web-tree-sitter";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import type { ExtractedFile } from "./types.js";
import { extractFromTypeScript } from "./languages/typescript.js";
import { extractFromPython } from "./languages/python.js";

// Use createRequire to locate WASM grammar files from tree-sitter-wasms
const require = createRequire(import.meta.url);

let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;
let pyParser: Parser | null = null;
let initialized = false;

export async function initParsers(): Promise<void> {
  if (initialized) return;

  await Parser.init();

  // Resolve WASM grammar paths from tree-sitter-wasms package
  const wasmsDir = dirname(require.resolve("tree-sitter-wasms/package.json"));

  const tsWasmPath = join(wasmsDir, "out", "tree-sitter-typescript.wasm");
  const tsxWasmPath = join(wasmsDir, "out", "tree-sitter-tsx.wasm");
  const pyWasmPath = join(wasmsDir, "out", "tree-sitter-python.wasm");

  const TypeScriptLang = await Parser.Language.load(tsWasmPath);
  const TsxLang = await Parser.Language.load(tsxWasmPath);
  const PythonLang = await Parser.Language.load(pyWasmPath);

  tsParser = new Parser();
  tsParser.setLanguage(TypeScriptLang);

  tsxParser = new Parser();
  tsxParser.setLanguage(TsxLang);

  pyParser = new Parser();
  pyParser.setLanguage(PythonLang);

  initialized = true;
}

function getParser(language: "typescript" | "python", isTsx: boolean): Parser {
  if (!initialized) throw new Error("Call initParsers() before parsing");
  if (language === "python") return pyParser!;
  if (isTsx) return tsxParser!;
  return tsParser!;
}

export function parseFile(
  absolutePath: string,
  relativePath: string,
  language: "typescript" | "python"
): ExtractedFile | null {
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }

  // Skip very large files (>2MB) to avoid hanging
  if (source.length > 2_000_000) {
    console.error(`  [ctx] Skipping oversized file: ${relativePath}`);
    return null;
  }

  try {
    const isTsx = relativePath.endsWith(".tsx");
    const parser = getParser(language, isTsx);
    const tree = parser.parse(source);

    if (language === "typescript") {
      const { symbols, imports, calls } = extractFromTypeScript(tree, source);
      return { path: relativePath, language, symbols, imports, calls };
    }

    if (language === "python") {
      const { symbols, imports, calls } = extractFromPython(tree, source);
      return { path: relativePath, language, symbols, imports, calls };
    }
  } catch (err) {
    console.error(`  [ctx] Parse error in ${relativePath}:`, err);
    return null;
  }

  return null;
}
