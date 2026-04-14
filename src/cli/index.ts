#!/usr/bin/env node
import { program } from "commander";
import { resolve, join, relative } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync, writeFileSync, statSync, readFileSync } from "fs";
import chalk from "chalk";
import ora from "ora";
import { watch } from "chokidar";

import { scanDirectory, hashFile, getLanguage, ensureCtxIgnore, loadIgnoreFilter } from "../scanner/scanner.js";
import { parseFile, initParsers } from "../parser/parser.js";
import {
  getDb,
  upsertFile,
  insertExtractedFile,
  getFileByPath,
  deleteFile,
} from "../storage/db.js";
import { resolveImports } from "../graph/build.js";
import { generateCNR } from "../compress/cnr.js";
import { startMCPServer } from "../server/mcp.js";
import { buildSearchIndex, searchSymbols } from "../search/bm25.js";
import { handleExpandSymbol } from "../server/handlers.js";

program
  .name("ctx")
  .description("Codebase Context Compiler — turns any repo into an AI-readable map")
  .version("0.2.0");

// ── BUILD ──────────────────────────────────────────────────────────────────
program
  .command("build [dir]")
  .description("Parse and index a codebase, then emit the CNR file")
  .option("--max-tokens <n>", "Soft token limit for CNR output", "80000")
  .option("--no-docstrings", "Omit docstrings from CNR output")
  .option("--include-private", "Include non-exported symbols")
  .option("--silent", "Suppress progress output")
  .action(async (dir: string = ".", options) => {
    const rootDir = resolve(dir);
    const ctxDir = join(rootDir, ".ctx");
    mkdirSync(ctxDir, { recursive: true });
    ensureCtxIgnore(rootDir);

    const dbPath = join(ctxDir, "index.db");
    const cnrPath = join(ctxDir, "repo.cnr");

    if (!options.silent) {
      console.log(chalk.bold(`\n  ctx build  →  ${rootDir}\n`));
    }

    // 1. Scan
    const scanSpinner = options.silent ? null : ora("Scanning files…").start();
    const files = await scanDirectory(rootDir);
    scanSpinner?.succeed(`Found ${chalk.cyan(files.length)} source files`);

    // 2. Parse and store
    const db = getDb(dbPath);
    await initParsers();

    // Track which paths are still present to detect deletions
    const currentPaths = new Set(files.map((f) => f.relativePath));

    const parseSpinner = options.silent ? null : ora("Parsing and indexing…").start();
    let parsed = 0;
    let skipped = 0;

    for (const file of files) {
      const existing = getFileByPath(db, file.relativePath);
      if (existing && existing.hash === file.hash) {
        skipped++;
        continue;
      }

      const extracted = parseFile(
        file.absolutePath,
        file.relativePath,
        file.language
      );

      if (!extracted) {
        skipped++;
        continue;
      }

      const fileId = upsertFile(
        db,
        file.relativePath,
        file.hash,
        file.language
      );
      insertExtractedFile(db, fileId, extracted);
      parsed++;

      parseSpinner && (parseSpinner.text = `Parsing… ${parsed} parsed, ${skipped} unchanged`);
    }

    // Remove deleted files from index
    const allIndexed = db
      .prepare("SELECT path FROM files")
      .all() as Array<{ path: string }>;
    let deleted = 0;
    for (const { path } of allIndexed) {
      if (!currentPaths.has(path)) {
        deleteFile(db, path);
        deleted++;
      }
    }

    parseSpinner?.succeed(
      `Indexed ${chalk.cyan(parsed)} files (${chalk.gray(skipped)} unchanged, ${deleted > 0 ? chalk.red(deleted + " deleted") : "0 deleted"})`
    );

    // 3. Resolve imports (reads tsconfig.json for path aliases)
    const graphSpinner = options.silent ? null : ora("Resolving imports…").start();
    resolveImports(db, rootDir);
    graphSpinner?.succeed("Import graph built");

    // 4. Generate CNR
    const cnrSpinner = options.silent ? null : ora("Generating CNR…").start();
    const cnrText = generateCNR(db, {
      maxTokens: parseInt(options.maxTokens),
      includeDocstrings: options.docstrings !== false,
      includePrivate: options.includePrivate ?? false,
    });
    writeFileSync(cnrPath, cnrText, "utf-8");

    const lineCount = cnrText.split("\n").length;
    const sizeKB = (Buffer.byteLength(cnrText) / 1024).toFixed(1);
    const estTokens = Math.ceil(cnrText.length / 3.5);

    cnrSpinner?.succeed(
      `CNR written: ${chalk.cyan(lineCount)} lines, ${sizeKB} KB, ~${chalk.yellow(estTokens.toLocaleString())} tokens`
    );

    if (!options.silent) {
      console.log(chalk.dim(`\n  Output: ${cnrPath}\n`));
    }
  });

// ── SERVE ──────────────────────────────────────────────────────────────────
program
  .command("serve [dir]")
  .description("Start the MCP server for the indexed codebase")
  .action(async (dir: string = ".") => {
    const rootDir = resolve(dir);
    const dbPath = join(rootDir, ".ctx", "index.db");

    if (!existsSync(dbPath)) {
      console.error(
        chalk.red(`No index found at ${dbPath}. Run "ctx build ${dir}" first.`)
      );
      process.exit(1);
    }

    await startMCPServer(rootDir, dbPath);
  });

// ── WATCH ──────────────────────────────────────────────────────────────────
program
  .command("watch [dir]")
  .description("Watch for file changes and incrementally rebuild the index")
  .option("--max-tokens <n>", "Soft token limit for CNR output", "80000")
  .action(async (dir: string = ".", options) => {
    const rootDir = resolve(dir);
    const ctxDir = join(rootDir, ".ctx");
    ensureCtxIgnore(rootDir);

    if (!existsSync(join(ctxDir, "index.db"))) {
      console.log(chalk.dim("No existing index — running initial build…"));
      // Run the build command inline
      const { execSync } = await import("child_process");
      const __filename = fileURLToPath(import.meta.url);
      execSync(`"${process.execPath}" "${join(__filename, "../index.js")}" build "${rootDir}"`, {
        stdio: "inherit",
      });
    }

    console.log(chalk.bold(`\n  ctx watch  →  ${rootDir}`));
    console.log(chalk.dim("  Watching for changes. Press Ctrl+C to stop.\n"));

    const db = getDb(join(ctxDir, "index.db"));
    await initParsers();

    // Use shared ignore filter (.ctxignore + hardcoded defaults)
    const ig = loadIgnoreFilter(rootDir);

    // Debounce rebuild to avoid thrashing on bulk saves
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    const changedFiles = new Set<string>();

    async function rebuildChanged() {
      const toProcess = [...changedFiles];
      changedFiles.clear();

      for (const absolutePath of toProcess) {
        const relativePath = relative(rootDir, absolutePath).replace(/\\/g, "/");

        // Skip empty paths (e.g. root dir events from chokidar)
        if (!relativePath) continue;

        // Apply ignore rules (.ctxignore + defaults)
        if (ig.ignores(relativePath)) continue;

        const lang = getLanguage(relativePath);
        if (!lang) continue;

        if (!existsSync(absolutePath)) {
          deleteFile(db, relativePath);
          console.log(chalk.red(`  - ${relativePath}`));
          continue;
        }

        const hash = await hashFile(absolutePath);
        const existing = getFileByPath(db, relativePath);
        if (existing && existing.hash === hash) continue;

        const extracted = parseFile(absolutePath, relativePath, lang);
        if (!extracted) continue;

        const fileId = upsertFile(db, relativePath, hash, lang);
        insertExtractedFile(db, fileId, extracted);
        console.log(chalk.cyan(`  ↺ ${relativePath}`));
      }

      resolveImports(db, rootDir);

      const cnrText = generateCNR(db, {
        maxTokens: parseInt(options.maxTokens),
      });
      writeFileSync(join(ctxDir, "repo.cnr"), cnrText, "utf-8");
      console.log(chalk.dim(`  CNR updated — ${Math.ceil(cnrText.length / 3.5).toLocaleString()} tokens`));
    }

    // chokidar v5: watch directory with filter function (no glob patterns)
    const watcher = watch(rootDir, {
      ignored: (filePath: string, stats?: { isFile: () => boolean }) => {
        if (!stats) return false;
        // Match scanDirectory default ignores
        if (filePath.includes("/.ctx/") || filePath.includes("\\.ctx\\")) return true;
        if (filePath.includes("/node_modules/") || filePath.includes("\\node_modules\\")) return true;
        if (filePath.includes("/dist/") || filePath.includes("\\dist\\")) return true;
        if (filePath.includes("/build/") || filePath.includes("\\build\\")) return true;
        if (filePath.includes("/.next/") || filePath.includes("\\.next\\")) return true;
        if (filePath.includes("/coverage/") || filePath.includes("\\coverage\\")) return true;
        if (!stats.isFile()) return false;
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        return !["ts", "tsx", "js", "mjs", "py"].includes(ext);
      },
      persistent: true,
    });

    watcher.on("all", (_event: string, filePath: string) => {
      changedFiles.add(filePath);
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuildChanged, 300);
    });

    // Keep process alive
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
  });

// ── QUERY ──────────────────────────────────────────────────────────────────
program
  .command("query [dir]")
  .description("Print the CNR overview to stdout")
  .option("--max-tokens <n>", "Token limit", "80000")
  .action((dir: string = ".", options) => {
    const rootDir = resolve(dir);
    const dbPath = join(rootDir, ".ctx", "index.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Run "ctx build" first.`));
      process.exit(1);
    }

    const db = getDb(dbPath);
    const cnrText = generateCNR(db, {
      maxTokens: parseInt(options.maxTokens),
    });
    process.stdout.write(cnrText);
  });

// ── EXPAND ─────────────────────────────────────────────────────────────────
program
  .command("expand <path> [dir]")
  .description(
    "Print source of a specific symbol or file to stdout.\n" +
    "  Examples:\n" +
    '    ctx expand src/auth/login.ts\n' +
    '    ctx expand src/auth/login.ts:AuthService.login\n'
  )
  .action((path: string, dir: string = ".") => {
    const rootDir = resolve(dir);
    const dbPath = join(rootDir, ".ctx", "index.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Run "ctx build" first.`));
      process.exit(1);
    }

    const db = getDb(dbPath);
    const result = handleExpandSymbol(
      { db, rootDir, searchIndex: null as any, cnrCache: null },
      { path }
    );
    process.stdout.write(result + "\n");
  });

// ── SEARCH ─────────────────────────────────────────────────────────────────
program
  .command("search <query> [dir]")
  .description("Search for symbols by keyword")
  .option("-n, --limit <n>", "Number of results", "20")
  .action((query: string, dir: string = ".", options) => {
    const rootDir = resolve(dir);
    const dbPath = join(rootDir, ".ctx", "index.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Run "ctx build" first.`));
      process.exit(1);
    }

    const db = getDb(dbPath);
    const index = buildSearchIndex(db);
    const results = searchSymbols(index, query, parseInt(options.limit));

    if (results.length === 0) {
      console.log(chalk.yellow(`No results for "${query}"`));
      return;
    }

    console.log(chalk.bold(`\n  Results for "${query}":\n`));
    for (const r of results) {
      console.log(
        `  ${chalk.cyan(r.kind.padEnd(10))} ${chalk.white(r.fqn)}  ${chalk.dim(r.path)}`
      );
      if (r.docstring) {
        console.log(chalk.dim(`    ${r.docstring.split("\n")[0].slice(0, 80)}`));
      }
    }
    console.log();
  });

// ── STATS ──────────────────────────────────────────────────────────────────
program
  .command("stats [dir]")
  .description("Show compression stats for the current index")
  .action((dir: string = ".") => {
    const rootDir = resolve(dir);
    const dbPath = join(rootDir, ".ctx", "index.db");
    const cnrPath = join(rootDir, ".ctx", "repo.cnr");

    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Run "ctx build" first.`));
      process.exit(1);
    }

    const db = getDb(dbPath);
    const fileCount = (db.prepare("SELECT COUNT(*) as n FROM files").get() as any).n;
    const symbolCount = (db.prepare("SELECT COUNT(*) as n FROM symbols").get() as any).n;
    const callCount = (db.prepare("SELECT COUNT(*) as n FROM calls").get() as any).n;

    let cnrTokens = 0;
    let cnrLines = 0;
    if (existsSync(cnrPath)) {
      const text = readFileSync(cnrPath, "utf-8");
      cnrTokens = Math.ceil(text.length / 3.5);
      cnrLines = text.split("\n").length;
    }

    console.log(chalk.bold("\n  ctx stats\n"));
    console.log(`  Files indexed:  ${chalk.cyan(fileCount)}`);
    console.log(`  Symbols:        ${chalk.cyan(symbolCount)}`);
    console.log(`  Call edges:     ${chalk.cyan(callCount)}`);
    console.log(`  CNR lines:      ${chalk.cyan(cnrLines)}`);
    console.log(`  CNR tokens:     ${chalk.yellow("~" + cnrTokens.toLocaleString())}`);
    console.log();
  });

program.parse(process.argv);
