export interface ExtractedSymbol {
  name: string;
  fqn: string;             // fully qualified name: "AuthService.login", "login", etc.
  kind: "function" | "class" | "method" | "type" | "interface" | "const" | "variable";
  signature: string;
  docstring: string | null;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  parentName: string | null; // for methods: the class name
}

export interface ExtractedImport {
  importedFrom: string;        // raw import path as written in source
  resolvedPath: string | null; // absolute path if resolvable (after alias resolution)
  importedNames: string[];     // named imports ["foo", "bar"] or ["*"] for namespace
}

export interface ExtractedCall {
  callerFqn: string;   // FQN of calling symbol: "AuthService.login"
  calleeName: string;  // what is being called — may be unresolved
  line: number;
}

export interface ExtractedFile {
  path: string;
  language: "typescript" | "python";
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
}
