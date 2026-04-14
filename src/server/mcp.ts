import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { join } from "path";
import { buildSearchIndex } from "../search/bm25.js";
import {
  handleGetOverview,
  handleExpandSymbol,
  handleFindReferences,
  handleSearch,
  type HandlerContext,
} from "./handlers.js";

export async function startMCPServer(
  rootDir: string,
  dbPath: string
): Promise<void> {
  const db = new Database(dbPath);
  const searchIndex = buildSearchIndex(db);

  const ctx: HandlerContext = {
    db,
    rootDir,
    searchIndex,
    cnrCache: null,
  };

  const server = new McpServer({
    name: "ctx",
    version: "0.2.0",
  });

  server.registerTool(
    "get_overview",
    {
      title: "Get codebase overview",
      description:
        "Returns the full CNR (Compressed Navigable Representation) of the entire codebase. " +
        "Includes every exported symbol, its signature, all imports, and call relationships. " +
        "Call this once at the start of a session to understand architecture. " +
        "Roughly 5–15% of the token cost of reading all files raw. " +
        "Files omitted due to the token budget show a stub with instructions to expand them.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: handleGetOverview(ctx) }],
    })
  );

  server.registerTool(
    "expand_symbol",
    {
      title: "Expand a symbol or file",
      description:
        "Returns the full source code of a specific function, method, or class. " +
        "Use this when you need to read or modify an actual implementation. " +
        'Format: { "path": "src/auth/login.ts:AuthService.login" }. ' +
        "Omit the symbol to get the entire file.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "File path and optional symbol, e.g. 'src/auth/login.ts:AuthService.login'. " +
            "Omit symbol to return the full file."
          ),
        symbol: z
          .string()
          .optional()
          .describe("Symbol name (alternative to including it in path)"),
      },
    },
    async ({ path, symbol }) => ({
      content: [{ type: "text", text: handleExpandSymbol(ctx, { path, symbol }) }],
    })
  );

  server.registerTool(
    "find_references",
    {
      title: "Find all references to a symbol",
      description:
        "Returns all locations in the codebase that call or import a given symbol. " +
        "Use this to understand the impact of changing a function, or to find all usages of an interface. " +
        "Prefer FQN format: 'AuthService.login' rather than just 'login' to avoid false matches.",
      inputSchema: {
        symbol: z
          .string()
          .describe(
            "Symbol name to find references for, e.g. 'AuthService.login' or 'validateToken'"
          ),
      },
    },
    async ({ symbol }) => ({
      content: [{ type: "text", text: handleFindReferences(ctx, { symbol }) }],
    })
  );

  server.registerTool(
    "search",
    {
      title: "Search symbols by keyword",
      description:
        "BM25 keyword search across all symbol names, FQNs, docstrings, and signatures. " +
        "Use this when you know roughly what you are looking for but not the exact symbol name or file. " +
        "Returns ranked results with file paths and FQNs.",
      inputSchema: {
        query: z
          .string()
          .describe("Search query, e.g. 'authentication' or 'database connection'"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of results (default 20)"),
      },
    },
    async ({ query, limit }) => ({
      content: [{ type: "text", text: handleSearch(ctx, { query, limit }) }],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`ctx MCP server v0.2.0 started for: ${rootDir}`);
}
