import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ExtractedFile } from "../parser/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Per-path connection pool — fixes the singleton-ignores-path bug
const connections = new Map<string, Database.Database>();

export function getDb(dbPath: string): Database.Database {
  const existing = connections.get(dbPath);
  if (existing) return existing;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  connections.set(dbPath, db);
  return db;
}

export function closeDb(dbPath: string): void {
  const db = connections.get(dbPath);
  if (db) {
    db.close();
    connections.delete(dbPath);
  }
}

export function upsertFile(
  db: Database.Database,
  path: string,
  hash: string,
  language: string
): number {
  const existing = db
    .prepare("SELECT id FROM files WHERE path = ?")
    .get(path) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE files SET hash = ?, last_indexed = ? WHERE id = ?"
    ).run(hash, Date.now(), existing.id);

    // Cascade deletes handle symbols/imports/calls via FK ON DELETE CASCADE
    db.prepare("DELETE FROM symbols WHERE file_id = ?").run(existing.id);
    db.prepare("DELETE FROM imports WHERE file_id = ?").run(existing.id);
    db.prepare("DELETE FROM calls WHERE file_id = ?").run(existing.id);

    return existing.id;
  }

  const result = db
    .prepare(
      "INSERT INTO files (path, hash, language, last_indexed) VALUES (?, ?, ?, ?)"
    )
    .run(path, hash, language, Date.now());

  return result.lastInsertRowid as number;
}

export function deleteFile(db: Database.Database, path: string): void {
  // Cascade handles child rows
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
}

export function insertExtractedFile(
  db: Database.Database,
  fileId: number,
  data: ExtractedFile
): void {
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (file_id, name, fqn, kind, signature, docstring, line_start, line_end, is_exported, parent_name)
    VALUES (@fileId, @name, @fqn, @kind, @signature, @docstring, @lineStart, @lineEnd, @isExported, @parentName)
  `);

  const insertImport = db.prepare(`
    INSERT INTO imports (file_id, imported_from, resolved_path, imported_names)
    VALUES (@fileId, @importedFrom, @resolvedPath, @importedNames)
  `);

  const insertCall = db.prepare(`
    INSERT INTO calls (file_id, caller_fqn, callee_name, line)
    VALUES (@fileId, @callerFqn, @calleeName, @line)
  `);

  const insertAll = db.transaction(() => {
    for (const sym of data.symbols) {
      insertSymbol.run({
        fileId,
        name: sym.name,
        fqn: sym.fqn,
        kind: sym.kind,
        signature: sym.signature,
        docstring: sym.docstring,
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        isExported: sym.isExported ? 1 : 0,
        parentName: sym.parentName,
      });
    }
    for (const imp of data.imports) {
      insertImport.run({
        fileId,
        importedFrom: imp.importedFrom,
        resolvedPath: imp.resolvedPath,
        importedNames: JSON.stringify(imp.importedNames),
      });
    }
    for (const call of data.calls) {
      insertCall.run({
        fileId,
        callerFqn: call.callerFqn,
        calleeName: call.calleeName,
        line: call.line,
      });
    }
  });

  insertAll();
}

export function getAllFiles(db: Database.Database) {
  return db.prepare("SELECT * FROM files ORDER BY path").all() as Array<{
    id: number;
    path: string;
    hash: string;
    language: string;
    last_indexed: number;
  }>;
}

export function getSymbolsForFile(db: Database.Database, fileId: number) {
  return db
    .prepare("SELECT * FROM symbols WHERE file_id = ? ORDER BY line_start")
    .all(fileId) as Array<{
    id: number;
    name: string;
    fqn: string;
    kind: string;
    signature: string | null;
    docstring: string | null;
    line_start: number;
    line_end: number;
    is_exported: number;
    parent_name: string | null;
  }>;
}

export function getImportsForFile(db: Database.Database, fileId: number) {
  return db
    .prepare("SELECT * FROM imports WHERE file_id = ?")
    .all(fileId) as Array<{
    imported_from: string;
    resolved_path: string | null;
    imported_names: string;
  }>;
}

export function getCallsForFile(db: Database.Database, fileId: number) {
  return db
    .prepare(
      "SELECT DISTINCT caller_fqn, callee_name FROM calls WHERE file_id = ? ORDER BY caller_fqn"
    )
    .all(fileId) as Array<{ caller_fqn: string; callee_name: string }>;
}

export function findReferences(
  db: Database.Database,
  symbolName: string
): Array<{ path: string; caller_fqn: string; line: number }> {
  // Match exact callee name or class-qualified "ClassName.symbolName" patterns
  return db
    .prepare(`
      SELECT f.path, c.caller_fqn, c.line
      FROM calls c
      JOIN files f ON c.file_id = f.id
      WHERE c.callee_name = ?
         OR c.callee_name LIKE '%.' || ?
      ORDER BY f.path, c.line
    `)
    .all(symbolName, symbolName) as Array<{
    path: string;
    caller_fqn: string;
    line: number;
  }>;
}

export function findImporters(
  db: Database.Database,
  symbolName: string
): Array<{ path: string }> {
  // Find files that explicitly import the given symbol by name
  return db
    .prepare(`
      SELECT DISTINCT f.path
      FROM imports i
      JOIN files f ON i.file_id = f.id
      WHERE EXISTS (
        SELECT 1 FROM json_each(i.imported_names)
        WHERE json_each.value = ?
      )
      ORDER BY f.path
    `)
    .all(symbolName) as Array<{ path: string }>;
}

export function getFileByPath(
  db: Database.Database,
  path: string
): { id: number; hash: string } | undefined {
  return db
    .prepare("SELECT id, hash FROM files WHERE path = ?")
    .get(path) as { id: number; hash: string } | undefined;
}

export function getSymbolLocation(
  db: Database.Database,
  filePath: string,
  symbolName: string
): { line_start: number; line_end: number } | undefined {
  // Try FQN match first, then name match
  const byFqn = db
    .prepare(`
      SELECT s.line_start, s.line_end
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE f.path = ? AND s.fqn = ?
      LIMIT 1
    `)
    .get(filePath, symbolName) as { line_start: number; line_end: number } | undefined;

  if (byFqn) return byFqn;

  return db
    .prepare(`
      SELECT s.line_start, s.line_end
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE f.path = ? AND s.name = ?
      LIMIT 1
    `)
    .get(filePath, symbolName) as
    | { line_start: number; line_end: number }
    | undefined;
}

export function getAllSymbols(db: Database.Database) {
  return db
    .prepare(`
      SELECT s.name, s.fqn, s.kind, s.signature, s.docstring, s.is_exported, f.path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
    `)
    .all() as Array<{
    name: string;
    fqn: string;
    kind: string;
    signature: string | null;
    docstring: string | null;
    is_exported: number;
    path: string;
  }>;
}
