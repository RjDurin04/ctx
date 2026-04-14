import { resolve, dirname, join, extname } from "path";
import { existsSync } from "fs";
import Database from "better-sqlite3";
import { getTsconfig, createPathsMatcher } from "get-tsconfig";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
const PY_EXTENSIONS = [".py", "/__init__.py"];

export function buildPathsMatcherForRoot(rootDir: string) {
  try {
    const tsconfig = getTsconfig(rootDir);
    if (!tsconfig) return null;
    return createPathsMatcher(tsconfig);
  } catch {
    return null;
  }
}

function resolveImportPath(
  importedFrom: string,
  fromFile: string,
  rootDir: string,
  pathsMatcher: ReturnType<typeof createPathsMatcher> | null
): string | null {
  // External packages
  if (!importedFrom.startsWith(".") && !importedFrom.startsWith("/")) {
    // Try tsconfig alias resolution first
    if (pathsMatcher) {
      const candidates = pathsMatcher(importedFrom);
      for (const candidate of candidates) {
        const absoluteCandidate = join(rootDir, candidate);
        if (existsSync(absoluteCandidate)) return absoluteCandidate;
        for (const ext of TS_EXTENSIONS) {
          const withExt = absoluteCandidate + ext;
          if (existsSync(withExt)) return withExt;
        }
      }
    }
    return null; // true external package — not indexable
  }

  const fromDir = dirname(join(rootDir, fromFile));
  const rawResolved = resolve(fromDir, importedFrom);

  if (existsSync(rawResolved) && !rawResolved.includes(".")) return rawResolved;

  const allExtensions = [...TS_EXTENSIONS, ...PY_EXTENSIONS];
  for (const ext of allExtensions) {
    const candidate = rawResolved + ext;
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function resolveImports(
  db: Database.Database,
  rootDir: string
): void {
  const pathsMatcher = buildPathsMatcherForRoot(rootDir);

  const files = db
    .prepare("SELECT id, path FROM files")
    .all() as Array<{ id: number; path: string }>;

  const fileById = new Map<number, string>();
  for (const f of files) fileById.set(f.id, f.path);

  const allImports = db
    .prepare("SELECT id, file_id, imported_from FROM imports")
    .all() as Array<{ id: number; file_id: number; imported_from: string }>;

  const update = db.prepare(
    "UPDATE imports SET resolved_path = ? WHERE id = ?"
  );

  const updateAll = db.transaction(() => {
    for (const imp of allImports) {
      const fromFile = fileById.get(imp.file_id);
      if (!fromFile) continue;
      const resolved = resolveImportPath(
        imp.imported_from,
        fromFile,
        rootDir,
        pathsMatcher
      );
      if (resolved) update.run(resolved, imp.id);
    }
  });

  updateAll();
}
