-- Per-user reading todo drafts. The payload stores a normalized paper draft
-- that can later be published into the shared papers table.
CREATE TABLE IF NOT EXISTS todo_papers (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_todo_papers_user_updated ON todo_papers(user_id, updated_at);
