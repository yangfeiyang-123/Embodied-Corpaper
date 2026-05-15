ALTER TABLE papers ADD COLUMN categories TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN tags TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN status TEXT DEFAULT '深读中';
ALTER TABLE papers ADD COLUMN created_by TEXT DEFAULT '';
ALTER TABLE papers ADD COLUMN updated_by TEXT DEFAULT '';

UPDATE papers
SET categories = category
WHERE (categories IS NULL OR categories = '') AND category IS NOT NULL AND category != '';

CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status);
CREATE INDEX IF NOT EXISTS idx_papers_updated_by ON papers(updated_by);
