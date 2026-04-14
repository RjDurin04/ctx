import type Parser from "web-tree-sitter";
import type {
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "../types.js";

function getText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function getLeadingDocstring(
  node: Parser.SyntaxNode,
  source: string
): string | null {
  // Walk backwards through siblings to find a JSDoc or line comment
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === "comment") {
    const text = getText(sibling, source).trim();
    if (text.startsWith("/**")) {
      return text
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
    }
    if (text.startsWith("//")) {
      return text.replace(/^\/\/\s?/gm, "").trim();
    }
    sibling = sibling.previousNamedSibling;
  }
  return null;
}

/**
 * Build a human-readable signature from a function or arrow function node.
 * Works for: function declarations, arrow functions, method definitions.
 * The node passed must be the one that owns "parameters" and optionally "return_type".
 */
function buildFunctionSignature(
  name: string,
  node: Parser.SyntaxNode,
  source: string,
  isAsync: boolean
): string {
  const paramsNode = node.childForFieldName("parameters");
  const returnNode = node.childForFieldName("return_type");
  const params = paramsNode ? getText(paramsNode, source) : "()";
  const ret = returnNode ? " " + getText(returnNode, source) : "";
  const prefix = isAsync ? "async " : "";
  return `${prefix}${name}${params}${ret}`;
}

function extractCallsFromNode(
  node: Parser.SyntaxNode,
  callerFqn: string,
  source: string,
  calls: ExtractedCall[]
): void {
  if (node.type === "call_expression") {
    const fnNode = node.childForFieldName("function");
    if (fnNode) {
      const calleeName = getText(fnNode, source)
        .replace(/\s+/g, "")
        .substring(0, 100);
      if (calleeName && !calleeName.includes("\n")) {
        calls.push({
          callerFqn,
          calleeName,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
  for (const child of node.namedChildren) {
    extractCallsFromNode(child, callerFqn, source, calls);
  }
}

export function extractFromTypeScript(
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
      // ── IMPORTS ────────────────────────────────────────────────────────
      case "import_statement": {
        const sourceNode = node.childForFieldName("source");
        if (!sourceNode) break;
        const importedFrom = getText(sourceNode, source).replace(/['"]/g, "");
        const names: string[] = [];

        // In web-tree-sitter, import_clause might not have a named field.
        // Walk children to find named_imports, namespace_import, identifier.
        for (const child of node.namedChildren) {
          if (child.type === "import_clause") {
            for (const clauseChild of child.namedChildren) {
              if (clauseChild.type === "named_imports") {
                for (const specifier of clauseChild.namedChildren) {
                  if (specifier.type === "import_specifier") {
                    const nameNode = specifier.childForFieldName("name");
                    if (nameNode) names.push(getText(nameNode, source));
                  }
                }
              }
              if (clauseChild.type === "namespace_import") {
                names.push("*");
              }
              if (clauseChild.type === "identifier" && names.length === 0) {
                names.push(getText(clauseChild, source));
              }
            }
            // Also check direct children (non-named) for default imports
            for (const c of child.children) {
              if (c.type === "identifier" && names.length === 0) {
                names.push(getText(c, source));
              }
            }
          }
        }

        imports.push({ importedFrom, resolvedPath: null, importedNames: names });
        break;
      }

      // ── EXPORT STATEMENTS ───────────────────────────────────────────────
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        if (decl) {
          walk(decl, currentClass);
        }
        // Handle: export { foo, bar } and export { foo } from './other'
        const namedExports = node.namedChildren.find((c) => c.type === "export_clause");
        if (namedExports) {
          // These are re-exports; we note the import but don't create symbols
          const srcNode = node.childForFieldName("source");
          if (srcNode) {
            const importedFrom = getText(srcNode, source).replace(/['"]/g, "");
            const names: string[] = [];
            for (const spec of namedExports.namedChildren) {
              if (spec.type === "export_specifier") {
                const nameNode = spec.childForFieldName("name");
                if (nameNode) names.push(getText(nameNode, source));
              }
            }
            imports.push({ importedFrom, resolvedPath: null, importedNames: names });
          }
        }
        break;
      }

      // ── FUNCTION DECLARATIONS ──────────────────────────────────────────
      case "function_declaration": {
        const isExported = node.parent?.type === "export_statement";
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? getText(nameNode, source) : "anonymous";
        const fqn = currentClass ? `${currentClass}.${name}` : name;
        const isAsync = node.children.some((c) => c.type === "async");
        const sig = buildFunctionSignature(name, node, source, isAsync);
        const docstring = getLeadingDocstring(
          node.parent?.type === "export_statement" ? node.parent : node,
          source
        );

        symbols.push({
          name, fqn, kind: "function", signature: sig, docstring,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          isExported, parentName: currentClass,
        });

        const bodyNode = node.childForFieldName("body");
        if (bodyNode) extractCallsFromNode(bodyNode, fqn, source, calls);
        return;
      }

      // ── LEXICAL DECLARATIONS (const/let fn = () => {}) ─────────────────
      case "lexical_declaration": {
        // const foo = async () => {} or const foo = function() {}
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;
          const nameNode = declarator.childForFieldName("name");
          const valueNode = declarator.childForFieldName("value");
          if (!nameNode || !valueNode) continue;

          const isArrow = valueNode.type === "arrow_function";
          const isFuncExpr = valueNode.type === "function_expression";
          if (!isArrow && !isFuncExpr) continue;

          const name = getText(nameNode, source);
          const fqn = currentClass ? `${currentClass}.${name}` : name;
          const isAsync = valueNode.children.some((c) => c.type === "async");
          const isExported = node.parent?.type === "export_statement";

          const sig = buildFunctionSignature(name, valueNode, source, isAsync);
          const docstring = getLeadingDocstring(
            node.parent?.type === "export_statement" ? node.parent : node,
            source
          );

          symbols.push({
            name, fqn, kind: "function", signature: sig, docstring,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExported, parentName: currentClass,
          });

          const bodyNode = valueNode.childForFieldName("body");
          if (bodyNode) extractCallsFromNode(bodyNode, fqn, source, calls);
        }
        break;
      }

      // ── CLASS DECLARATIONS ─────────────────────────────────────────────
      case "class_declaration":
      case "class": {
        const nameNode = node.childForFieldName("name");
        const className = nameNode ? getText(nameNode, source) : "AnonymousClass";
        const isExported = node.parent?.type === "export_statement";
        const docstring = getLeadingDocstring(
          node.parent?.type === "export_statement" ? node.parent : node,
          source
        );

        symbols.push({
          name: className,
          fqn: className,
          kind: "class",
          signature: `class ${className}`,
          docstring,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          isExported,
          parentName: null,
        });

        const bodyNode = node.childForFieldName("body");
        if (bodyNode) {
          for (const member of bodyNode.namedChildren) {
            walk(member, className);
          }
        }
        return;
      }

      // ── METHOD DEFINITIONS ─────────────────────────────────────────────
      case "method_definition": {
        const nameNode = node.childForFieldName("name");
        const methodName = nameNode ? getText(nameNode, source) : "anonymous";
        const fqn = currentClass ? `${currentClass}.${methodName}` : methodName;

        // method_definition owns parameters and return_type directly,
        // NOT via a "value" field — that was a bug in the previous version.
        const isAsync = node.children.some((c) => c.type === "async");
        const sig = buildFunctionSignature(methodName, node, source, isAsync);
        const docstring = getLeadingDocstring(node, source);

        symbols.push({
          name: methodName,
          fqn,
          kind: "method",
          signature: sig,
          docstring,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          isExported: true, // accessible via class
          parentName: currentClass,
        });

        const bodyNode = node.childForFieldName("body");
        if (bodyNode) extractCallsFromNode(bodyNode, fqn, source, calls);
        return;
      }

      // ── TYPES & INTERFACES ─────────────────────────────────────────────
      case "type_alias_declaration":
      case "interface_declaration": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? getText(nameNode, source) : "AnonymousType";
        const isExported = node.parent?.type === "export_statement";
        const kind = node.type === "interface_declaration" ? "interface" : "type";

        symbols.push({
          name,
          fqn: name,
          kind,
          signature: `${kind} ${name}`,
          docstring: getLeadingDocstring(
            node.parent?.type === "export_statement" ? node.parent : node,
            source
          ),
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          isExported,
          parentName: null,
        });
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
