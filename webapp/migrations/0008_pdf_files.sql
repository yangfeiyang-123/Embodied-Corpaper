-- PDF attachments stored in R2 with metadata and highlight annotations in D1.
CREATE TABLE IF NOT EXISTS paper_files (
  scope TEXT NOT NULL,
  record_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT DEFAULT 'application/pdf',
  size INTEGER DEFAULT 0,
  annotations_json TEXT DEFAULT '[]',
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (scope, record_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_files_scope_updated ON paper_files(scope, updated_at);
