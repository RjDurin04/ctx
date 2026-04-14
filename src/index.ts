/**
 * @ctx-compiler/ctx — Codebase Context Compiler
 *
 * Programmatic API for scanning, parsing, and compressing codebases
 * into AI-readable maps.
 *
 * @example
 * ```ts
 * import { scanDirectory, initParsers, parseFile, getDb, generateCNR } from "@ctx-compiler/ctx";
 *
 * const files = await scanDirectory("./my-project");
 * await initParsers();
 * const db = getDb(".ctx/index.db");
 * // ... parse files, build graph, generate CNR
 * ```
 */

// ── Scanner ────────────────────────────────────────────────────────────────
export { scanDirectory, hashFile, getLanguage } from "./scanner/scanner.js";
export type { ScannedFile } from "./scanner/scanner.js";

// ── Parser ─────────────────────────────────────────────────────────────────
export { initParsers, parseFile } from "./parser/parser.js";
export type {
  ExtractedFile,
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "./parser/types.js";

// ── Storage ────────────────────────────────────────────────────────────────
export {
  getDb,
  closeDb,
  upsertFile,
  insertExtractedFile,
  deleteFile,
  getFileByPath,
  getAllFiles,
  getSymbolsForFile,
  getImportsForFile,
  getCallsForFile,
  findReferences,
  findImporters,
  getSymbolLocation,
  getAllSymbols,
} from "./storage/db.js";

// ── Graph ──────────────────────────────────────────────────────────────────
export { resolveImports, buildPathsMatcherForRoot } from "./graph/build.js";

// ── Compression ────────────────────────────────────────────────────────────
export { generateCNR } from "./compress/cnr.js";

// ── Search ─────────────────────────────────────────────────────────────────
export { buildSearchIndex, searchSymbols } from "./search/bm25.js";
export type { SearchResult } from "./search/bm25.js";

// ── MCP Server ─────────────────────────────────────────────────────────────
export { startMCPServer } from "./server/mcp.js";
export {
  handleGetOverview,
  handleExpandSymbol,
  handleFindReferences,
  handleSearch,
} from "./server/handlers.js";
export type { HandlerContext } from "./server/handlers.js";
