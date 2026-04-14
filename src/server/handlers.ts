import { readFileSync, statSync } from "fs";
import { join, resolve, relative, normalize } from "path";
import Database from "better-sqlite3";
import MiniSearch from "minisearch";
import { generateCNR } from "../compress/cnr.js";
import { findReferences, findImporters, getSymbolLocation } from "../storage/db.js";
import { searchSymbols } from "../search/bm25.js";

export interface HandlerContext {
  db: Database.Database;
  rootDir: string;
  searchIndex: MiniSearch;
  cnrCache: { text: string; mtime: number } | null;
}

export function handleGetOverview(ctx: HandlerContext): string {
  const cnrPath = join(ctx.rootDir, ".ctx", "repo.cnr");

  try {
    const stat = statSync(cnrPath);
    const mtime = stat.mtimeMs;

    // Return cached version if file hasn't changed since last read
    if (ctx.cnrCache && ctx.cnrCache.mtime === mtime) {
      return ctx.cnrCache.text;
    }

    const text = readFileSync(cnrPath, "utf-8");
    ctx.cnrCache = { text, mtime };
    return text;
  } catch {
    // CNR file doesn't exist yet — generate on the fly
    const text = generateCNR(ctx.db);
    ctx.cnrCache = { text, mtime: Date.now() };
    return text;
  }
}

/**
 * Sanitize a file path argument to prevent path traversal attacks.
 * Returns null if the resolved path escapes the rootDir.
 */
function sanitizeFilePath(
  rawPath: string,
  rootDir: string
): string | null {
  const normalized = normalize(rawPath.replace(/\\/g, "/"));
  const absolute = resolve(rootDir, normalized);
  const rel = relative(rootDir, absolute);

  // rel must not start with ".." and must not be an absolute path
  if (rel.startsWith("..") || resolve(rel) === rel) return null;
  return absolute;
}

export function handleExpandSymbol(
  ctx: HandlerContext,
  args: { path: string; symbol?: string }
): string {
  const [rawFilePath, inlineSymbol] = args.path.split(":");
  const symbolName = inlineSymbol ?? args.symbol;

  // Sanitize to prevent directory traversal (e.g. ../../../etc/passwd)
  const absolutePath = sanitizeFilePath(rawFilePath, ctx.rootDir);
  if (!absolutePath) {
    return `Error: path "${rawFilePath}" is outside the indexed root.`;
  }

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf-8");
  } catch {
    return `Error: file not found at ${rawFilePath}`;
  }

  if (!symbolName) {
    return `// ${rawFilePath}\n${source}`;
  }

  const location = getSymbolLocation(ctx.db, rawFilePath, symbolName);
  if (!location) {
    return `Error: symbol "${symbolName}" not found in ${rawFilePath}. ` +
      `Use get_overview() to see valid symbols, or search("${symbolName}") to find its file.`;
  }

  const lines = source.split("\n");
  const extracted = lines
    .slice(location.line_start - 1, location.line_end)
    .join("\n");

  return `// ${rawFilePath}:${symbolName} (L${location.line_start}–L${location.line_end})\n${extracted}`;
}

export function handleFindReferences(
  ctx: HandlerContext,
  args: { symbol: string }
): string {
  const callRefs = findReferences(ctx.db, args.symbol);
  const importRefs = findImporters(ctx.db, args.symbol);

  if (callRefs.length === 0 && importRefs.length === 0) {
    return `No references found for "${args.symbol}". ` +
      `Tip: use the FQN format like "AuthService.login" if results are ambiguous.`;
  }

  const linesList: string[] = [];

  if (callRefs.length > 0) {
    linesList.push(`Call references to "${args.symbol}" (${callRefs.length} found):\n`);
    for (const ref of callRefs) {
      linesList.push(`  ${ref.path}:L${ref.line}  (in ${ref.caller_fqn})`);
    }
  }

  if (importRefs.length > 0) {
    if (linesList.length > 0) linesList.push("");
    linesList.push(`Import references to "${args.symbol}" (${importRefs.length} found):\n`);
    for (const ref of importRefs) {
      linesList.push(`  ${ref.path}  (imports "${args.symbol}")`);
    }
  }

  return linesList.join("\n");
}

export function handleSearch(
  ctx: HandlerContext,
  args: { query: string; limit?: number }
): string {
  const results = searchSymbols(ctx.searchIndex, args.query, args.limit ?? 20);

  if (results.length === 0) {
    return `No symbols found matching "${args.query}"`;
  }

  const linesList = [`Search results for "${args.query}" (${results.length} matches):\n`];
  for (const r of results) {
    linesList.push(`  ${r.kind.padEnd(10)} ${r.fqn}  →  ${r.path}`);
    if (r.signature) linesList.push(`    sig: ${r.signature}`);
    if (r.docstring) linesList.push(`    doc: ${r.docstring.split("\n")[0].slice(0, 80)}`);
    linesList.push("");
  }
  return linesList.join("\n");
}
