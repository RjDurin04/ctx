import type Parser from "web-tree-sitter";
import type {
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "../types.js";

function getText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function getPythonDocstring(
  node: Parser.SyntaxNode,
  source: string
): string | null {
  const body = node.childForFieldName("body");
  if (!body) return null;
  const first = body.namedChildren[0];
  if (!first) return null;
  if (first.type === "expression_statement") {
    const expr = first.namedChildren[0];
    if (expr && expr.type === "string") {
      return getText(expr, source)
        .replace(/^["']{3}/, "")
        .replace(/["']{3}$/, "")
        .trim();
    }
  }
  return null;
}

function extractCallsPython(
  node: Parser.SyntaxNode,
  callerFqn: string,
  source: string,
  calls: ExtractedCall[]
): void {
  if (node.type === "call") {
    const fnNode = node.childForFieldName("function");
    if (fnNode) {
      const callee = getText(fnNode, source)
        .replace(/\s+/g, "")
        .substring(0, 100);
      if (callee && !callee.includes("\n")) {
        calls.push({ callerFqn, calleeName: callee, line: node.startPosition.row + 1 });
      }
    }
  }
  for (const child of node.namedChildren) {
    extractCallsPython(child, callerFqn, source, calls);
  }
}

export function extractFromPython(
  tree: Parser.Tree,
  source: string
): {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
} {
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];

  function walk(node: Parser.SyntaxNode, currentClass: string | null = null) {
    switch (node.type) {
      case "import_statement": {
        const names: string[] = [];
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name" || child.type === "aliased_import") {
            names.push(getText(child, source).split(" as ")[0]);
          }
        }
        if (names.length > 0) {
          imports.push({ importedFrom: names[0], resolvedPath: null, importedNames: names });
        }
        break;
      }

      case "import_from_statement": {
        const moduleNode = node.childForFieldName("module_name");
        const importedFrom = moduleNode ? getText(moduleNode, source) : "";
        const names: string[] = [];
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name" && child !== moduleNode) {
            names.push(getText(child, source));
          }
          if (child.type === "aliased_import") {
            const n = child.childForFieldName("name");
            if (n) names.push(getText(n, source));
          }
          if (child.type === "wildcard_import") names.push("*");
        }
        imports.push({ importedFrom, resolvedPath: null, importedNames: names });
        break;
      }

      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        const funcName = nameNode ? getText(nameNode, source) : "anonymous";
        const fqn = currentClass ? `${currentClass}.${funcName}` : funcName;
        const paramsNode = node.childForFieldName("parameters");
        const returnNode = node.childForFieldName("return_type");
        const params = paramsNode ? getText(paramsNode, source) : "()";
        const ret = returnNode ? " -> " + getText(returnNode, source) : "";
        const isAsync = node.children.some((c) => c.type === "async");
        const sig = `${isAsync ? "async " : ""}def ${funcName}${params}${ret}`;
        const docstring = getPythonDocstring(node, source);

        symbols.push({
          name: funcName,
          fqn,
          kind: currentClass ? "method" : "function",
          signature: sig,
          docstring,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          isExported: !funcName.startsWith("_"),
          parentName: currentClass,
        });

        const body = node.childForFieldName("body");
        if (body) extractCallsPython(body, fqn, source, calls);
        return;
      }

      case "class_definition": {
        const nameNode = node.childForFieldName("name");
        const className = nameNode ? getText(nameNode, source) : "AnonymousClass";
        const docstring = getPythonDocstring(node, source);

        symbols.push({
          name: className,
          fqn: className,
          kind: "class",
          signature: `class ${className}`,
          docstring,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          isExported: !className.startsWith("_"),
          parentName: null,
        });

        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, className);
          }
        }
        return;
      }
    }

    for (const child of node.namedChildren) {
      walk(child, currentClass);
    }
  }

  walk(tree.rootNode);
  return { symbols, imports, calls };
}
