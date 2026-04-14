import MiniSearch from "minisearch";
import Database from "better-sqlite3";
import { getAllSymbols } from "../storage/db.js";

export interface SearchResult {
  name: string;
  fqn: string;
  kind: string;
  path: string;
  signature: string | null;
  docstring: string | null;
  score: number;
}

export function buildSearchIndex(db: Database.Database): MiniSearch {
  const symbols = getAllSymbols(db);

  const index = new MiniSearch({
    fields: ["name", "fqn", "docstring", "signature"],
    storeFields: ["name", "fqn", "kind", "path", "signature", "docstring"],
    searchOptions: {
      boost: { fqn: 4, name: 3, docstring: 2, signature: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });

  const docs = symbols.map((s, i) => ({
    id: i,
    name: s.name,
    fqn: s.fqn,
    kind: s.kind,
    path: s.path,
    signature: s.signature ?? "",
    docstring: s.docstring ?? "",
  }));

  index.addAll(docs);
  return index;
}

export function searchSymbols(
  index: MiniSearch,
  query: string,
  limit = 20
): SearchResult[] {
  const results = index.search(query);
  return results.slice(0, limit).map((r) => ({
    name: r.name as string,
    fqn: r.fqn as string,
    kind: r.kind as string,
    path: r.path as string,
    signature: (r.signature as string) || null,
    docstring: (r.docstring as string) || null,
    score: r.score,
  }));
}
