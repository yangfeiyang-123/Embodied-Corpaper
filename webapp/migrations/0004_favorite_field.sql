-- Add favorite column to papers table
ALTER TABLE papers ADD COLUMN favorite TEXT DEFAULT '否';
