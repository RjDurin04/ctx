import Database from "better-sqlite3";
import {
  getAllFiles,
  getSymbolsForFile,
  getImportsForFile,
  getCallsForFile,
} from "../storage/db.js";

const CNR_VERSION = "1";
const CTX_VERSION = "0.2.0";

interface CNROptions {
  maxTokens?: number;
  includePrivate?: boolean;
  includeDocstrings?: boolean;
}

function estimateTokens(text: string): number {
  // ~3.5 chars per token for code (slightly tighter than the 4-char heuristic)
  return Math.ceil(text.length / 3.5);
}

function formatSignature(
  sig: string | null,
  name: string,
  lineStart: number
): string {
  const displaySig = sig || name;
  const lineRef = `[L${lineStart}]`;
  const padded = displaySig.length > 58
    ? displaySig.substring(0, 55) + "..."
    : displaySig.padEnd(58);
  return `  ${padded} ${lineRef}`;
}

export function generateCNR(
  db: Database.Database,
  options: CNROptions = {}
): string {
  const {
    maxTokens = 80000,
    includePrivate = false,
    includeDocstrings = true,
  } = options;

  const files = getAllFiles(db);
  const lines: string[] = [];

  // Version header — allows downstream tools to detect format changes
  lines.push(`# cnr-version: ${CNR_VERSION}  ctx: ${CTX_VERSION}`);
  lines.push("");

  // Score files by import count (more importers = higher centrality)
  // Also give a bonus to files with zero importers that call many things (entry points)
  const importCounts = new Map<string, number>();
  for (const file of files) {
    const imports = getImportsForFile(db, file.id);
    for (const imp of imports) {
      if (imp.resolved_path) {
        // Compare against relative paths stored in the DB, not absolute paths
        const key = imp.resolved_path;
        importCounts.set(key, (importCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const callCounts = new Map<string, number>();
  for (const file of files) {
    const calls = getCallsForFile(db, file.id);
    callCounts.set(file.path, calls.length);
  }

  const sortedFiles = [...files].sort((a, b) => {
    const aImports = importCounts.get(a.path) ?? 0;
    const bImports = importCounts.get(b.path) ?? 0;
    if (aImports !== bImports) return bImports - aImports;

    // Entry point bonus: 0 importers but makes many calls
    const aIsEntry = aImports === 0 && (callCounts.get(a.path) ?? 0) > 5;
    const bIsEntry = bImports === 0 && (callCounts.get(b.path) ?? 0) > 5;
    if (aIsEntry !== bIsEntry) return aIsEntry ? -1 : 1;

    return a.path.localeCompare(b.path);
  });

  let tokenBudget = maxTokens;

  for (const file of sortedFiles) {
    const symbols = getSymbolsForFile(db, file.id);
    const imports = getImportsForFile(db, file.id);
    const calls = getCallsForFile(db, file.id);

    const exportedSymbols = includePrivate
      ? symbols
      : symbols.filter((s) => s.is_exported === 1);

    if (exportedSymbols.length === 0 && imports.length === 0) continue;

    const fileLines: string[] = [];
    fileLines.push(`# module: ${file.path}`);

    // Exports section — group methods under class, use FQNs in call section
    if (exportedSymbols.length > 0) {
      fileLines.push("## exports");
      const topLevel = exportedSymbols.filter((s) => !s.parent_name);
      const byParent = new Map<string, typeof exportedSymbols>();

      for (const sym of exportedSymbols) {
        if (sym.parent_name) {
          const existing = byParent.get(sym.parent_name) ?? [];
          existing.push(sym);
          byParent.set(sym.parent_name, existing);
        }
      }

      for (const sym of topLevel) {
        fileLines.push(formatSignature(sym.signature, sym.name, sym.line_start));
        if (includeDocstrings && sym.docstring) {
          fileLines.push(`    "${sym.docstring.split("\n")[0].slice(0, 80)}"`);
        }

        if (sym.kind === "class") {
          const methods = byParent.get(sym.name) ?? [];
          for (const method of methods) {
            fileLines.push(
              "  " + formatSignature(method.signature, method.name, method.line_start)
            );
            if (includeDocstrings && method.docstring) {
              fileLines.push(`      "${method.docstring.split("\n")[0].slice(0, 80)}"`);
            }
          }
        }
      }
    }

    // Imports section — only local imports
    const localImports = imports.filter((i) => i.imported_from.startsWith("."));
    if (localImports.length > 0) {
      fileLines.push("## imports");
      for (const imp of localImports) {
        const names = JSON.parse(imp.imported_names) as string[];
        fileLines.push(`  → ${imp.imported_from}: ${names.join(", ")}`);
      }
    }

    // Calls section — uses FQNs, grouped by caller
    if (calls.length > 0) {
      fileLines.push("## calls");
      const byCallerMap = new Map<string, Set<string>>();
      for (const call of calls) {
        const existing = byCallerMap.get(call.caller_fqn) ?? new Set();
        existing.add(call.callee_name);
        byCallerMap.set(call.caller_fqn, existing);
      }
      for (const [caller, callees] of byCallerMap) {
        fileLines.push(`  ${caller} → ${[...callees].join(", ")}`);
      }
    }

    fileLines.push("");

    const blockText = fileLines.join("\n");
    const blockTokens = estimateTokens(blockText);

    if (tokenBudget - blockTokens < 0) {
      // Over budget — stub the file so the AI knows it exists but was omitted
      // and can request it via expand_symbol with just the file path
      lines.push(`# module: ${file.path}`);
      lines.push(`  [omitted — over token budget; call expand_symbol("${file.path}") to load]`);
      lines.push("");
      continue;
    }

    tokenBudget -= blockTokens;
    lines.push(blockText);
  }

  return lines.join("\n");
}
