-- User accounts and per-user favorites
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (user_id, paper_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_paper_id ON favorites(paper_id);
