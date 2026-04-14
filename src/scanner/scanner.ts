import fg from "fast-glob";
import { createReadStream, existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { createRequire } from "module";
import { join, relative, resolve } from "path";
import type { Ignore } from "ignore";

// Use createRequire to properly load the CJS `ignore` package under NodeNext
const require = createRequire(import.meta.url);
const ignore = require("ignore") as () => Ignore;

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  language: "typescript" | "python";
  hash: string;
}

const LANGUAGE_PATTERNS: Record<string, "typescript" | "python"> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".py": "python",
};

export function getLanguage(filePath: string): "typescript" | "python" | null {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return LANGUAGE_PATTERNS[ext] ?? null;
}

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function scanDirectory(
  rootDir: string,
  extraIgnorePatterns: string[] = []
): Promise<ScannedFile[]> {
  const absoluteRoot = resolve(rootDir);

  const ig = ignore();
  const defaultIgnores = [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".next/**",
    "coverage/**",
    "*.min.js",
    "*.map",
    ".ctx/**",
  ];
  ig.add(defaultIgnores);
  ig.add(extraIgnorePatterns);

  const gitignorePath = join(absoluteRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }

  const ctxignorePath = join(absoluteRoot, ".ctxignore");
  if (existsSync(ctxignorePath)) {
    ig.add(readFileSync(ctxignorePath, "utf-8"));
  }

  const allFiles = await fg("**/*", {
    cwd: absoluteRoot,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const results: ScannedFile[] = [];

  for (const relPath of allFiles) {
    if (ig.ignores(relPath)) continue;

    const lang = getLanguage(relPath);
    if (!lang) continue;

    const absolutePath = join(absoluteRoot, relPath);
    const hash = await hashFile(absolutePath);

    results.push({
      absolutePath,
      relativePath: relPath,
      language: lang,
      hash,
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
