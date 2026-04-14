CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    UNIQUE NOT NULL,
  hash        TEXT    NOT NULL,
  language    TEXT    NOT NULL,
  last_indexed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  fqn         TEXT    NOT NULL,  -- "AuthService.login" or "login" for top-level
  kind        TEXT    NOT NULL,
  signature   TEXT,
  docstring   TEXT,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL,
  is_exported INTEGER NOT NULL DEFAULT 0,
  parent_name TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  imported_from    TEXT    NOT NULL,
  resolved_path    TEXT,
  imported_names   TEXT    NOT NULL  -- JSON array
);

CREATE TABLE IF NOT EXISTS calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  caller_fqn   TEXT    NOT NULL,  -- FQN of calling symbol
  callee_name  TEXT    NOT NULL,
  line         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name     ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_fqn      ON symbols(fqn);
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported);
CREATE INDEX IF NOT EXISTS idx_imports_file     ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_calls_file       ON calls(file_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee     ON calls(callee_name);
