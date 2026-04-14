import fg from "fast-glob";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "fs";
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

/** Default patterns that ctx always ignores. */
export const DEFAULT_IGNORES = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".nuxt/**",
  ".output/**",
  ".vercel/**",
  "out/**",
  "coverage/**",
  "*.min.js",
  "*.map",
  ".ctx/**",
  "__pycache__/**",
  ".venv/**",
  "venv/**",
  "*.lock",
  "package-lock.json",
];

/** Template content for auto-generated .ctxignore files. */
const CTXIGNORE_TEMPLATE = `# ─── ctx ignore ─────────────────────────────────────────────────────────
# Patterns listed here are excluded from ctx build, watch, and serve.
# Uses gitignore-style syntax.  Lines starting with # are comments.
#
# These defaults are always applied internally:
#   node_modules  .git  dist  build  .next  .nuxt  .output  .vercel
#   out  coverage  *.min.js  *.map  .ctx  __pycache__  .venv  venv
#   *.lock  package-lock.json
#
# Add your own project-specific patterns below:
# ────────────────────────────────────────────────────────────────────────

# Test fixtures
tests/fixtures/**

# Generated / codegen files
**/*.generated.ts
**/*.gen.ts
src/graphql/generated/**

# Database seeds / migrations (remove if you want AI to see them)
seeds/**
migrations/**

# Storybook
.storybook/**
stories/**

# Static / public assets (images, fonts, etc.)
public/**
static/**
assets/**

# Logs
logs/**
*.log
`;

/**
 * Ensure a .ctxignore file exists in the project root.
 * Creates one with sensible defaults if missing. Returns the path.
 */
export function ensureCtxIgnore(rootDir: string): string {
  const ctxignorePath = join(rootDir, ".ctxignore");
  if (!existsSync(ctxignorePath)) {
    writeFileSync(ctxignorePath, CTXIGNORE_TEMPLATE, "utf-8");
  }
  return ctxignorePath;
}

/**
 * Build an Ignore instance from the hardcoded defaults + .ctxignore.
 * Shared by build, watch, and any other tool that needs filtering.
 */
export function loadIgnoreFilter(rootDir: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);

  const ctxignorePath = join(rootDir, ".ctxignore");
  if (existsSync(ctxignorePath)) {
    ig.add(readFileSync(ctxignorePath, "utf-8"));
  }

  return ig;
}

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

  const ig = loadIgnoreFilter(absoluteRoot);
  ig.add(extraIgnorePatterns);

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

