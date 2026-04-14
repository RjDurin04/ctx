# Ctx: Codebase Context Compiler

**Ctx** is an intelligent Codebase Context Compiler — a powerful CLI tool and Model Context Protocol (MCP) server that transforms any codebase into an AI-readable map. It's designed to solve the context window overflow problem encountered when providing large repositories to Large Language Models (LLMs).

## The Problem It Solves

When pair-programming with AI agents, feeding an entire codebase into an LLM's context window is often impossible—or at least horribly inefficient and expensive. Traditional vector-based search setups (RAG) lose structural understanding of the code, and blindly pasting files blows through token budgets instantly.

**Ctx** solves this by:
1. **Deterministically parsing your code via AST (Abstract Syntax Trees)** instead of lossy vector embeddings.
2. Building a local, strict **SQLite-backed graph** of symbols, functions, methods, and their import/call relationships.
3. Generating a **Compressed Navigable Representation (CNR)** (`.ctx/repo.cnr`), which yields a human-readable and highly token-efficient snapshot of the entire repository's architecture. AI models read the CNR and then know exactly where to selectively drill down via the provided MCP toolset, saving 80–90% compared to raw file ingestion.

## Core Features

- ⚡ **Local & Offline:** 100% local processing. No API keys, no network calls, and no embeddings to host.
- 🌳 **True AST Parsing:** Powered universally by WebAssembly (`web-tree-sitter`), bypassing cumbersome C++ build restraints across OS environments.
- 📉 **Aggressive Compression:** Generates a CNR structural overview file ranked by centrality (degree of connectivity), dynamically pruning long bodies and respecting token budgets.
- 🔌 **Seamless MCP Integration:** Built-in Model Context Protocol server exposing specific actions (`expand`, `search`, etc.) directly to AI surfaces like Claude Desktop and Cursor.
- 🔎 **Built-in BM25 Search:** Fully integrated MiniSearch for localized fuzzy and prefix searching over symbols and docstrings.

---

## Prerequisites

Before installing Ctx, make sure you have **Node.js version 20 or higher** installed on your machine.

**Check your Node.js version:**

```bash
node --version
```

You should see something like `v20.x.x` or higher. If you don't have Node.js installed, download it from [nodejs.org](https://nodejs.org/) (choose the LTS version).

---

## Installation & Setup

Ctx has **two uses**: a CLI tool for manual analysis, and an MCP server for AI integration. Both require the same installation. **Choose one** of the three options below — each option shows exactly what commands to run and what MCP config to use.

---

### Option A: Install globally (recommended)

Best for most users. Installs `ctx` as a command available system-wide.

**1. Install:**

```bash
npm install -g @ctx-compiler/ctx
```

**2. Verify it worked:**

```bash
ctx --version
# Should print: 0.2.0
```

> If you see `'ctx' is not recognized`, close and reopen your terminal.

**3. Build your project's index** (navigate to your project folder first):

```bash
cd C:\Projects\my-app
ctx build
```

**4. (Optional) Set up MCP for AI tools** — use this config:

```json
{
  "mcpServers": {
    "ctx-compiler": {
      "command": "ctx",
      "args": ["serve", "C:/Projects/my-app"]
    }
  }
}
```

> **💡 Recommended AI Instructions:**
> Copy the paragraph below and paste it into your AI's custom instructions (e.g., Cursor Rules, Claude System Prompt), or save it as an `.md` file inside your project so the AI knows how to query the server:
> 
> *"You have access to a ctx MCP server. At the start of every coding session, call get_overview() before doing anything else. Never guess file paths - use search() to locate symbols when unsure. Always call find_references() before modifying or renaming any exported function to understand full impact. Use expand_symbol() to read only the specific function bodies you need, not entire files. Treat call graph edges as strong navigation hints."*

---

### Option B: Use npx (no install required)

Best if you don't want to install anything permanently. Every command uses `npx @ctx-compiler/ctx` instead of `ctx`.

**1. Build your project's index:**

```bash
cd C:\Projects\my-app
npx -y @ctx-compiler/ctx build
```

> The `-y` flag auto-confirms the download. First run is slower because it downloads the package.

**2. Other commands also use `npx`:**

```bash
npx @ctx-compiler/ctx stats
npx @ctx-compiler/ctx search "auth"
npx @ctx-compiler/ctx expand src/auth/service.ts
```

**3. (Optional) Set up MCP for AI tools** — use this config (note: uses `npx` as the command):

```json
{
  "mcpServers": {
    "ctx-compiler": {
      "command": "npx",
      "args": ["-y", "@ctx-compiler/ctx", "serve", "C:/Projects/my-app"]
    }
  }
}
```

> **💡 Recommended AI Instructions:**
> The official MCP standard does not allow a `system` property inside the JSON configuration. Instead, copy the paragraph below and paste it into your AI's custom instructions, or save it as an `instructions.md` file inside your project:
> 
> *"You have access to a ctx MCP server. At the start of every coding session, call get_overview() before doing anything else. Never guess file paths - use search() to locate symbols when unsure. Always call find_references() before modifying or renaming any exported function to understand full impact. Use expand_symbol() to read only the specific function bodies you need, not entire files. Treat call graph edges as strong navigation hints."*

---

### Option C: Install from source (for contributors)

Best if you want to modify Ctx itself. After `npm link`, everything works exactly like Option A.

```bash
git clone https://github.com/RjDurin04/ctx.git
cd ctx
npm install
npm run build
npm link
```

After running `npm link`, the `ctx` command is now globally available — use the same commands and MCP config as **Option A**.

---

## Quick Start: Your First Build

> **Already done the install?** This section walks you through what `ctx build` actually does and what to expect.

### Step 1: Open your terminal and navigate to your project

```bash
# Windows
cd C:\Projects\my-app

# macOS / Linux
cd ~/Projects/my-app
```

### Step 2: Run the build command

```bash
# If you used Option A or C:
ctx build

# If you used Option B (npx):
npx -y @ctx-compiler/ctx build
```

**What this does:**
1. Scans your project for all supported source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.py`)
2. Parses every file into an Abstract Syntax Tree (AST) to extract functions, classes, imports, etc.
3. Builds an import/call graph linking all the symbols together
4. Saves everything to a local SQLite database at `.ctx/index.db`
5. Generates a compressed overview at `.ctx/repo.cnr`

**Expected output:**

```
  ctx build  →  C:\Projects\my-app

  ✔ Found 47 source files
  ✔ Indexed 47 files (0 unchanged, 0 deleted)
  ✔ Import graph built
  ✔ CNR written: 312 lines, 8.2 KB, ~2,342 tokens

  Output: C:\Projects\my-app\.ctx\repo.cnr
```

### Step 3: Check your results

After the build, you'll have a new `.ctx/` folder in your project:

```
your-project/
├── .ctx/
│   ├── index.db     ← SQLite database with all symbols and relationships
│   └── repo.cnr     ← Compressed overview for AI consumption
├── src/
│   └── ...
└── package.json
```

> **Tip:** Add `.ctx/` to your `.gitignore` — it's regenerated on every build and shouldn't be committed.

### Step 4: View your stats (optional)

```bash
ctx stats
```

This shows you a summary of what was indexed:

```
  ctx stats

  Files indexed:  47
  Symbols:        183
  Call edges:     271
  CNR lines:      312
  CNR tokens:     ~2,342
```

---

## CLI Commands Reference

All commands are run from inside your project's root folder.  
If you used **Option B (npx)**, replace `ctx` with `npx -y @ctx-compiler/ctx` in every command below.

### `ctx build [dir]`

Parse and index a codebase, then emit the CNR file. This is the main command you'll use.

```bash
# Index the current directory
ctx build

# Index a specific directory
ctx build C:\Projects\my-app

# Set a custom token limit (default: 80000)
ctx build --max-tokens 50000

# Include private (non-exported) symbols
ctx build --include-private

# Suppress all progress output
ctx build --silent
```

### `ctx search <query>`

Search for symbols (functions, classes, variables) by keyword.

```bash
# Find anything related to "auth"
ctx search auth

# Limit results
ctx search auth --limit 5
```

**Example output:**

```
  Results for "auth":

  function   validateToken        src/auth/middleware.ts
  class      AuthService          src/auth/service.ts
  method     AuthService.login    src/auth/service.ts
```

### `ctx expand <path>`

Print the full source code of a specific file or symbol.

```bash
# Print entire file
ctx expand src/auth/service.ts

# Print just one function (use the format: file:SymbolName)
ctx expand src/auth/service.ts:AuthService.login
```

### `ctx query`

Print the full CNR overview to your terminal (stdout). Useful for piping into other tools.

```bash
ctx query

# With a custom token limit
ctx query --max-tokens 40000
```

### `ctx watch`

Watch your project for file changes and automatically rebuild the index.

```bash
ctx watch
```

Press `Ctrl+C` to stop watching.

### `ctx serve`

Start the MCP server (see the AI Integration section below).

```bash
ctx serve
```

---

## AI Integration (MCP Server)

This is the most powerful feature of Ctx. It runs an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that AI tools can connect to. Just add the JSON configuration from your chosen installation method to your MCP client's settings.


### Verification

In your AI tool, ask:

> "What's the overall structure of this codebase?"

The AI should call `get_overview()` and return a structured summary of your project. If that works, you're all set!

### MCP Tools Available to the AI

Once connected, your AI gets 4 tools:

| Tool | What It Does |
|------|-------------|
| **`get_overview`** | Returns the full CNR compressed map of your codebase. The AI calls this first to understand the architecture. |
| **`expand_symbol`** | Zooms into the full source code of a specific function, class, or file. The AI uses this when it needs to read actual code. |
| **`find_references`** | Finds all places in the codebase that call or import a given symbol. The AI uses this to understand the impact of changes. |
| **`search`** | Keyword search across all symbol names, signatures, and docstrings. The AI uses this when it's not sure where something is. |

---

## Programmatic API

You can also use Ctx as a library in your own Node.js / TypeScript projects.

### Install as a dependency

```bash
npm install @ctx-compiler/ctx
```

### Usage example

```typescript
import {
  scanDirectory,
  initParsers,
  parseFile,
  getDb,
  upsertFile,
  insertExtractedFile,
  resolveImports,
  generateCNR,
} from "@ctx-compiler/ctx";

// 1. Scan for source files
const files = await scanDirectory("./my-project");

// 2. Initialize the AST parsers (must be called once before parsing)
await initParsers();

// 3. Open (or create) the SQLite database
const db = getDb("./my-project/.ctx/index.db");

// 4. Parse and store each file
for (const file of files) {
  const extracted = parseFile(file.absolutePath, file.relativePath, file.language);
  if (!extracted) continue;

  const fileId = upsertFile(db, file.relativePath, file.hash, file.language);
  insertExtractedFile(db, fileId, extracted);
}

// 5. Resolve import relationships
resolveImports(db, "./my-project");

// 6. Generate the compressed overview
const cnr = generateCNR(db, { maxTokens: 80000 });
console.log(cnr);
```

### Available exports

| Module | Exports |
|--------|---------|
| **Scanner** | `scanDirectory`, `hashFile`, `getLanguage` |
| **Parser** | `initParsers`, `parseFile` |
| **Storage** | `getDb`, `closeDb`, `upsertFile`, `insertExtractedFile`, `deleteFile`, `getFileByPath`, `getAllFiles`, `getSymbolsForFile`, `findReferences`, `findImporters`, `getSymbolLocation`, `getAllSymbols` |
| **Graph** | `resolveImports`, `buildPathsMatcherForRoot` |
| **Compression** | `generateCNR` |
| **Search** | `buildSearchIndex`, `searchSymbols` |
| **MCP Server** | `startMCPServer`, `handleGetOverview`, `handleExpandSymbol`, `handleFindReferences`, `handleSearch` |

---

## Customizing What Gets Indexed

### Automatic ignoring

Ctx automatically ignores common non-source directories:
- `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `coverage/`
- Minified files (`*.min.js`) and source maps (`*.map`)
- The `.ctx/` output directory itself

It also respects your project's `.gitignore` file.

### Custom ignore rules (`.ctxignore`)

Create a `.ctxignore` file in your project root to exclude additional paths. The syntax is the same as `.gitignore`:

```gitignore
# Ignore test fixtures
tests/fixtures/**

# Ignore generated files
**/*.generated.ts
src/graphql/generated/**

# Ignore database seeds
seeds/**

# Ignore Storybook
.storybook/**
stories/**
```

### Supported languages

Currently Ctx supports:
- **TypeScript / JavaScript** — `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`
- **Python** — `.py`

---

## How It Works Under The Hood

1. **Scanner Filter:** Resolves against `.gitignore` and targeted `.ctxignore` configurations to omit large binary folders (`node_modules`, `.git`).
2. **Incremental Indexing:** Evaluates SHA-256 hashes against preexisting files ensuring that subsequent rebuilds parse only explicitly modified files.
3. **AST Graphing:** Leverages Tree-sitter WASM grammars (currently targeting TypeScript/JS & Python) to construct edges—tracking not just file paths, but deep Fully Qualified Names (`Package.Class.method`).
4. **Graph Build:** In TS/JS mode, intelligently inspects `tsconfig.json` to untangle `@alias/custom-paths` mapping into resolute file paths.
5. **Token Truncator:** Generates the CNR map ranked by "import centrality", guaranteeing core structural components make it into the tight LLM token window. Overflow files are gracefully rendered into expansion tool stubs.

---

## Updating, Uninstalling & Reinstalling

### Updating
To update your global installation to the latest version:
```bash
npm update -g @ctx-compiler/ctx
```

### Uninstalling
To completely remove the global package:
```bash
npm uninstall -g @ctx-compiler/ctx
```
*(Optional)* You may also want to delete the local `.ctx/` folders inside your projects.

### Reinstalling
If you are experiencing persistent issues and need a clean slate:
```bash
npm uninstall -g @ctx-compiler/ctx
npm cache clean --force
npm install -g @ctx-compiler/ctx
```

---

## Troubleshooting

### `'ctx' is not recognized` after global install

- **Windows:** Close and reopen your terminal (PowerShell / Command Prompt).
- **macOS / Linux:** Run `which ctx` to check if it's in your PATH. If using `nvm`, make sure your default Node version is set.
- Run `npm list -g @ctx-compiler/ctx` to verify it's installed globally.

### `No index found` error

You need to run `ctx build` in your project directory before using `ctx serve`, `ctx search`, `ctx expand`, or `ctx stats`.

### Build seems slow on first run

The first build parses every file. Subsequent builds are **incremental** — only changed files are re-parsed (detected via SHA-256 hash). A project with 100 files typically takes 2–5 seconds on first build and under 1 second on subsequent builds.

### `better-sqlite3` install errors

This package uses a native SQLite binding. On most systems it installs automatically using prebuilt binaries. If you encounter issues:

1. Make sure you have **Node.js 20+**
2. Try `npm install -g @ctx-compiler/ctx --build-from-source`
3. On Windows, you may need the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

---

## License

MIT — see [LICENSE](./LICENSE) for details.
