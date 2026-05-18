ALTER TABLE papers ADD COLUMN published_at TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN citation_count INTEGER DEFAULT 0;
ALTER TABLE papers ADD COLUMN citation_source TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_papers_published_at ON papers(published_at);
CREATE INDEX IF NOT EXISTS idx_papers_citation_count ON papers(citation_count);
