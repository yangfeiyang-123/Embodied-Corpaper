ALTER TABLE papers ADD COLUMN abstract TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN doi TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN arxiv_id TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN openreview_id TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN metadata_source TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN metadata_checked_at TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN canonical_url TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS idx_papers_arxiv_id ON papers(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_papers_openreview_id ON papers(openreview_id);
CREATE INDEX IF NOT EXISTS idx_papers_canonical_url ON papers(canonical_url);

CREATE TABLE IF NOT EXISTS metadata_cache (
  query TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  parent_id TEXT,
  author TEXT NOT NULL,
  type TEXT DEFAULT '其他',
  content TEXT NOT NULL,
  deleted TEXT DEFAULT '否',
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_paper_id ON comments(paper_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at);
