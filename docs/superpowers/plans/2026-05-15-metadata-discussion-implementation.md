# Metadata Recognition and Discussion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add paper metadata recognition, duplicate detection, and threaded paper discussions to the existing Cloudflare-backed team paper tracker.

**Architecture:** Keep the current Cloudflare Worker + D1 + static `index.html` architecture, but split new Worker logic into focused modules for metadata lookup, duplicate detection, and comments. Add D1 migrations first, then implement Worker endpoints, then wire the existing single-page frontend to those endpoints.

**Tech Stack:** Cloudflare Worker ES modules, Cloudflare D1 SQL, plain HTML/CSS/JavaScript frontend, Node built-in test runner for pure metadata utilities, Wrangler for local and remote verification.

---

## Scope Check

This plan implements one cohesive collaboration feature set: metadata recognition, duplicate detection, and paper discussions. The features are connected by the new-paper workflow and paper detail view, so they can be delivered as one testable increment.

This plan does not implement task assignment, deadlines, version restore, AI-generated deep-reading notes, or batch recognition.

The workspace is currently not a git repository. Commit steps are included because the execution skill expects them, but in the current environment they will be skipped unless a git repository is initialized first.

## File Structure

- Create `webapp/migrations/0003_metadata_comments.sql`
  - Adds metadata columns to `papers`.
  - Adds `metadata_cache`.
  - Adds `comments`.

- Create `webapp/src/paper-utils.js`
  - Owns paper field lists, list parsing, paper normalization, and row normalization.
  - Reduces responsibility in `worker.js`.

- Create `webapp/src/metadata.js`
  - Owns query classification, public API calls, candidate normalization, simple confidence scoring, duplicate detection, title similarity, and metadata cache helpers.

- Create `webapp/src/comments.js`
  - Owns comment CRUD handlers and comment normalization.

- Modify `webapp/src/worker.js`
  - Imports shared utilities.
  - Adds routes for metadata and comments.
  - Keeps core routing and auth.

- Modify `webapp/index.html`
  - Adds quick identify UI.
  - Adds hidden metadata state in the form.
  - Adds metadata display in detail view.
  - Adds discussion UI with top-level comments and one-level replies.

- Modify `webapp/server.py`
  - Keeps local Flask mode compatible with new metadata fields and comments endpoints.
  - Local mode does not need external metadata lookup parity in the first pass, but it must not break when serving records containing new fields.

- Modify `webapp/package.json`
  - Adds Node test script.

- Create `webapp/test/metadata.test.mjs`
  - Tests pure metadata utility functions without network.

---

### Task 1: Add D1 Schema for Metadata, Cache, and Comments

**Files:**
- Create: `webapp/migrations/0003_metadata_comments.sql`

- [ ] **Step 1: Create the migration**

Add this file:

```sql
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
```

- [ ] **Step 2: Run local migration**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
npm run d1:migrate:local
```

Expected: Wrangler reports `0003_metadata_comments.sql` with status `✅`.

- [ ] **Step 3: Verify local schema**

Run:

```bash
npx wrangler d1 execute embodied-papers-db --local --command="PRAGMA table_info(papers)"
npx wrangler d1 execute embodied-papers-db --local --command="PRAGMA table_info(comments)"
npx wrangler d1 execute embodied-papers-db --local --command="PRAGMA table_info(metadata_cache)"
```

Expected:

- `papers` includes `abstract`, `doi`, `arxiv_id`, `openreview_id`, `metadata_source`, `metadata_checked_at`, `canonical_url`.
- `comments` exists.
- `metadata_cache` exists.

- [ ] **Step 4: Commit**

If this workspace is a git repository, run:

```bash
git add webapp/migrations/0003_metadata_comments.sql
git commit -m "feat: add metadata and comments schema"
```

If `git status` returns `fatal: not a git repository`, skip this step and record that commit was not possible.

---

### Task 2: Extract Paper Normalization Utilities

**Files:**
- Create: `webapp/src/paper-utils.js`
- Modify: `webapp/src/worker.js`
- Test: `node --check webapp/src/paper-utils.js webapp/src/worker.js`

- [ ] **Step 1: Create `paper-utils.js`**

Create `webapp/src/paper-utils.js`:

```js
export const FIELDS = [
  'id',
  'category',
  'categories',
  'tags',
  'status',
  'week',
  'recorder',
  'readDate',
  'shared',
  'relevance',
  'novelty',
  'evidence',
  'inspiration',
  'reproducibility',
  'title',
  'source',
  'link',
  'direction',
  'oneSentence',
  'authors',
  'task',
  'motivation',
  'dataset',
  'platform',
  'signalAnalysis',
  'methodOverview',
  'methodDetails',
  'trainFlow',
  'hardware',
  'baselines',
  'metrics',
  'overallResults',
  'coreEffect',
  'ablation',
  'inferenceSpeed',
  'innovation1',
  'innovation2',
  'innovation3',
  'innovation4',
  'inspirationNote',
  'limitations',
  'newIdeas',
  'abstract',
  'doi',
  'arxiv_id',
  'openreview_id',
  'metadata_source',
  'metadata_checked_at',
  'canonical_url',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at'
];

const SCORE_FIELDS = new Set([
  'relevance',
  'novelty',
  'evidence',
  'inspiration',
  'reproducibility'
]);

export function parseList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
  }
  if (!value) return [];
  return Array.from(
    new Set(String(value).split(/[|,，;；\n]+/).map((item) => item.trim()).filter(Boolean))
  );
}

export function normalizeActor(value) {
  return String(value || '').trim();
}

export function normalizePaper(input) {
  const categories = parseList(input.categories || input.category);
  const normalized = Object.fromEntries(FIELDS.map((field) => [field, normalizeValue(field, input[field])]));
  normalized.categories = categories.join('|');
  normalized.category = normalized.category || categories[0] || '';
  normalized.tags = parseList(input.tags).join('|');
  normalized.status = normalized.status || '深读中';
  normalized.doi = normalizeIdentifier(normalized.doi);
  normalized.arxiv_id = normalizeIdentifier(normalized.arxiv_id);
  normalized.openreview_id = normalizeIdentifier(normalized.openreview_id);
  normalized.canonical_url = normalizeUrl(normalized.canonical_url || normalized.link);
  return normalized;
}

export function normalizeRows(rows) {
  return rows.map(normalizeRow);
}

export function normalizeRow(row) {
  if (!row) return null;
  const normalized = Object.fromEntries(Object.entries(row).map(([field, value]) => [field, normalizeValue(field, value)]));
  const categories = parseList(normalized.categories || normalized.category);
  normalized.categories = categories;
  normalized.category = normalized.category || categories[0] || '';
  normalized.tags = parseList(normalized.tags);
  normalized.status = normalized.status || '深读中';
  return normalized;
}

export function normalizeValue(field, value) {
  if (SCORE_FIELDS.has(field)) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  }
  return value ?? '';
}

export function normalizeIdentifier(value) {
  return String(value || '').trim();
}

export function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}

export function insertPaperStatement(env, paper, verb = 'INSERT') {
  const columns = FIELDS.join(', ');
  const placeholders = FIELDS.map(() => '?').join(', ');
  const values = FIELDS.map((field) => paper[field]);
  return env.DB.prepare(`${verb} INTO papers (${columns}) VALUES (${placeholders})`).bind(...values);
}

export function upsertPaperStatement(env, paper) {
  const columns = FIELDS.join(', ');
  const placeholders = FIELDS.map(() => '?').join(', ');
  const updateFields = FIELDS.filter((field) => field !== 'id' && field !== 'created_at');
  const sets = updateFields.map((field) => `${field} = excluded.${field}`).join(', ');
  const values = FIELDS.map((field) => paper[field]);
  return env.DB.prepare(
    `INSERT INTO papers (${columns}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${sets}`
  ).bind(...values);
}
```

- [ ] **Step 2: Update `worker.js` imports**

At the top of `webapp/src/worker.js`, replace local `FIELDS`, `SCORE_FIELDS`, `parseList`, `normalizePaper`, `normalizeRows`, `normalizeRow`, `normalizeActor`, `insertPaperStatement`, and `upsertPaperStatement` definitions with:

```js
import {
  FIELDS,
  insertPaperStatement,
  normalizeActor,
  normalizePaper,
  normalizeRow,
  normalizeRows,
  parseList,
  upsertPaperStatement
} from './paper-utils.js';
```

Keep `corsHeaders`, route handling, and JSON helpers in `worker.js`.

- [ ] **Step 3: Delete duplicate utility definitions from `worker.js`**

Remove these function or constant definitions from `worker.js` after importing them:

```js
const FIELDS = [...];
const SCORE_FIELDS = new Set([...]);
function insertPaperStatement(...) { ... }
function upsertPaperStatement(...) { ... }
function normalizePaper(...) { ... }
function normalizeRows(...) { ... }
function normalizeRow(...) { ... }
function normalizeValue(...) { ... }
function parseList(...) { ... }
function normalizeActor(...) { ... }
```

- [ ] **Step 4: Check syntax**

Run:

```bash
node --check webapp/src/paper-utils.js
node --check webapp/src/worker.js
```

Expected: no output and exit code `0`.

- [ ] **Step 5: Commit**

If git is available:

```bash
git add webapp/src/paper-utils.js webapp/src/worker.js
git commit -m "refactor: extract paper normalization utilities"
```

Otherwise skip and record that commit was not possible.

---

### Task 3: Add Pure Metadata Utilities and Tests

**Files:**
- Create: `webapp/src/metadata.js`
- Create: `webapp/test/metadata.test.mjs`
- Modify: `webapp/package.json`

- [ ] **Step 1: Add test script to `package.json`**

Add this script:

```json
{
  "scripts": {
    "test": "node --test"
  }
}
```

Keep all existing scripts unchanged.

- [ ] **Step 2: Create failing tests**

Create `webapp/test/metadata.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMetadataQuery,
  normalizeTitle,
  similarityScore,
  extractArxivId,
  extractOpenReviewId,
  normalizeCandidate,
  detectDuplicate
} from '../src/metadata.js';

test('classifies arXiv URL', () => {
  assert.deepEqual(classifyMetadataQuery('https://arxiv.org/abs/2401.12345'), {
    type: 'arxiv',
    value: '2401.12345'
  });
});

test('classifies DOI', () => {
  assert.deepEqual(classifyMetadataQuery('10.48550/arXiv.2401.12345'), {
    type: 'doi',
    value: '10.48550/arXiv.2401.12345'
  });
});

test('classifies OpenReview URL', () => {
  assert.deepEqual(classifyMetadataQuery('https://openreview.net/forum?id=abc123'), {
    type: 'openreview',
    value: 'abc123'
  });
});

test('normalizes title for fuzzy matching', () => {
  assert.equal(normalizeTitle('  A Robot-Learning Method: For Touch!  '), 'a robot learning method for touch');
});

test('scores similar titles highly', () => {
  assert.ok(similarityScore('A Robot Learning Method for Touch', 'robot learning method for touch') > 0.85);
});

test('extracts arXiv id from DOI-like string', () => {
  assert.equal(extractArxivId('10.48550/arXiv.2401.12345'), '2401.12345');
});

test('extracts OpenReview forum id', () => {
  assert.equal(extractOpenReviewId('https://openreview.net/forum?id=abc123'), 'abc123');
});

test('normalizes candidate shape', () => {
  const candidate = normalizeCandidate({
    title: 'Paper',
    year: 2024,
    venue: 'ICLR',
    source: 'OpenAlex',
    authors: ['A', 'B'],
    institutions: ['MIT'],
    abstract: 'Summary',
    doi: '10.1/example',
    arxiv_id: '2401.12345',
    openreview_id: '',
    url: 'https://example.com/'
  });
  assert.equal(candidate.title, 'Paper');
  assert.equal(candidate.year, '2024');
  assert.equal(candidate.authors, 'A; B');
  assert.equal(candidate.institutions, 'MIT');
  assert.equal(candidate.canonical_url, 'https://example.com');
});

test('detects DOI duplicate before title similarity', () => {
  const duplicate = detectDuplicate(
    { title: 'New title', doi: '10.1/example', canonical_url: '' },
    [{ id: 'p1', title: 'Old title', doi: '10.1/example', canonical_url: '' }]
  );
  assert.equal(duplicate.status, 'definite');
  assert.equal(duplicate.reason, 'doi');
  assert.equal(duplicate.paper.id, 'p1');
});

test('detects suspected duplicate by title similarity', () => {
  const duplicate = detectDuplicate(
    { title: 'A Robot Learning Method for Touch' },
    [{ id: 'p1', title: 'Robot Learning Method for Touch' }]
  );
  assert.equal(duplicate.status, 'suspected');
  assert.equal(duplicate.reason, 'title');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
npm test
```

Expected: FAIL because `webapp/src/metadata.js` does not exist.

- [ ] **Step 4: Implement pure metadata utilities**

Create `webapp/src/metadata.js` with this initial implementation:

```js
import { normalizeUrl } from './paper-utils.js';

export function classifyMetadataQuery(input) {
  const query = String(input || '').trim();
  const arxivId = extractArxivId(query);
  if (arxivId) return { type: 'arxiv', value: arxivId };

  const openreviewId = extractOpenReviewId(query);
  if (openreviewId) return { type: 'openreview', value: openreviewId };

  if (/^10\.\d{4,9}\/\S+$/i.test(query)) {
    return { type: 'doi', value: query };
  }

  return { type: 'title', value: query };
}

export function extractArxivId(input) {
  const text = String(input || '').trim();
  const urlMatch = text.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/i);
  if (urlMatch) return urlMatch[1];
  const doiMatch = text.match(/arXiv\.([0-9]{4}\.[0-9]{4,5})(v\d+)?/i);
  if (doiMatch) return doiMatch[1];
  const plainMatch = text.match(/^([0-9]{4}\.[0-9]{4,5})(v\d+)?$/i);
  if (plainMatch) return plainMatch[1];
  return '';
}

export function extractOpenReviewId(input) {
  const text = String(input || '').trim();
  try {
    const url = new URL(text);
    if (url.hostname.includes('openreview.net')) {
      return url.searchParams.get('id') || '';
    }
  } catch {
    return '';
  }
  return '';
}

export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function similarityScore(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

export function normalizeCandidate(raw) {
  const authors = Array.isArray(raw.authors) ? raw.authors.join('; ') : String(raw.authors || '');
  const institutions = Array.isArray(raw.institutions) ? raw.institutions.join('; ') : String(raw.institutions || '');
  const url = String(raw.url || raw.canonical_url || '').trim();
  return {
    title: String(raw.title || '').trim(),
    year: raw.year ? String(raw.year) : '',
    venue: String(raw.venue || '').trim(),
    source: String(raw.source || '').trim(),
    authors,
    institutions,
    abstract: String(raw.abstract || '').trim(),
    doi: String(raw.doi || '').trim(),
    arxiv_id: String(raw.arxiv_id || '').trim(),
    openreview_id: String(raw.openreview_id || '').trim(),
    url,
    canonical_url: normalizeUrl(raw.canonical_url || url),
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0
  };
}

export function detectDuplicate(candidate, papers) {
  const checks = [
    ['doi', candidate.doi],
    ['arxiv_id', candidate.arxiv_id],
    ['openreview_id', candidate.openreview_id],
    ['canonical_url', candidate.canonical_url]
  ];

  for (const [field, value] of checks) {
    if (!value) continue;
    const paper = papers.find((item) => String(item[field] || '').trim() === value);
    if (paper) return { status: 'definite', reason: field, paper };
  }

  let best = { paper: null, score: 0 };
  for (const paper of papers) {
    const score = similarityScore(candidate.title, paper.title);
    if (score > best.score) best = { paper, score };
  }
  if (best.paper && best.score >= 0.82) {
    return { status: 'suspected', reason: 'title', paper: best.paper, score: best.score };
  }

  return { status: 'none', reason: '', paper: null, score: 0 };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
npm test
```

Expected: all tests in `webapp/test/metadata.test.mjs` PASS.

- [ ] **Step 6: Commit**

If git is available:

```bash
git add webapp/package.json webapp/src/metadata.js webapp/test/metadata.test.mjs
git commit -m "test: add metadata utility coverage"
```

Otherwise skip and record that commit was not possible.

---

### Task 4: Add Metadata Source Adapters and Search Endpoint

**Files:**
- Modify: `webapp/src/metadata.js`
- Modify: `webapp/src/worker.js`
- Test: `webapp/test/metadata.test.mjs`

- [ ] **Step 1: Add source adapter exports to `metadata.js`**

Append this code to `webapp/src/metadata.js`:

```js
export async function searchMetadata(query, env, options = {}) {
  const classified = classifyMetadataQuery(query);
  const cacheKey = `${classified.type}:${classified.value}`.toLowerCase();
  const bypassCache = options.bypassCache === true;

  if (!bypassCache) {
    const cached = await getCachedMetadata(env, cacheKey, classified.type);
    if (cached) return { ...cached, fromCache: true };
  }

  const candidates = [];
  if (classified.type === 'arxiv') {
    candidates.push(...await searchArxiv(classified.value));
  } else if (classified.type === 'openreview') {
    candidates.push(...await searchOpenReview(classified.value));
  } else if (classified.type === 'doi') {
    candidates.push(...await searchCrossref(classified.value, 'doi'));
  } else {
    candidates.push(...await searchOpenAlex(classified.value));
    candidates.push(...await searchCrossref(classified.value, 'title'));
  }

  const uniqueCandidates = dedupeCandidates(candidates.map(normalizeCandidate)).slice(0, 8);
  const result = { queryType: classified.type, candidates: uniqueCandidates, fromCache: false };
  await putCachedMetadata(env, cacheKey, result);
  return result;
}

export async function searchArxiv(arxivId) {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const response = await fetch(url, { headers: { Accept: 'application/atom+xml' } });
  if (!response.ok) return [];
  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry) return [];
  const block = entry[1];
  const title = textFromXml(block, 'title');
  const abstract = textFromXml(block, 'summary');
  const published = textFromXml(block, 'published');
  const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)]
    .map((match) => decodeXml(match[1].trim()));
  return [normalizeCandidate({
    title,
    year: published.slice(0, 4),
    venue: 'arXiv',
    source: 'arXiv',
    authors,
    institutions: [],
    abstract,
    doi: '',
    arxiv_id: arxivId,
    openreview_id: '',
    url: `https://arxiv.org/abs/${arxivId}`,
    confidence: 0.98
  })];
}

export async function searchOpenReview(openreviewId) {
  const url = `https://api2.openreview.net/notes?id=${encodeURIComponent(openreviewId)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const data = await response.json();
  const note = Array.isArray(data.notes) ? data.notes[0] : null;
  if (!note) return [];
  const content = note.content || {};
  return [normalizeCandidate({
    title: content.title?.value || content.title || '',
    year: note.cdate ? new Date(note.cdate).getFullYear() : '',
    venue: content.venue?.value || content.venue || 'OpenReview',
    source: 'OpenReview',
    authors: content.authors?.value || content.authors || [],
    institutions: [],
    abstract: content.abstract?.value || content.abstract || '',
    doi: '',
    arxiv_id: '',
    openreview_id: openreviewId,
    url: `https://openreview.net/forum?id=${openreviewId}`,
    confidence: 0.95
  })];
}

export async function searchCrossref(value, mode) {
  const url = mode === 'doi'
    ? `https://api.crossref.org/works/${encodeURIComponent(value)}`
    : `https://api.crossref.org/works?rows=5&query.title=${encodeURIComponent(value)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const data = await response.json();
  const items = mode === 'doi' ? [data.message] : data.message?.items || [];
  return items.filter(Boolean).map((item) => normalizeCandidate({
    title: Array.isArray(item.title) ? item.title[0] : item.title || '',
    year: item.published?.['date-parts']?.[0]?.[0] || item.issued?.['date-parts']?.[0]?.[0] || '',
    venue: Array.isArray(item['container-title']) ? item['container-title'][0] : '',
    source: 'Crossref',
    authors: (item.author || []).map((author) => [author.given, author.family].filter(Boolean).join(' ')),
    institutions: [],
    abstract: stripHtml(item.abstract || ''),
    doi: item.DOI || '',
    arxiv_id: extractArxivId(item.DOI || ''),
    openreview_id: '',
    url: item.URL || '',
    confidence: mode === 'doi' ? 0.97 : 0.75
  }));
}

export async function searchOpenAlex(title) {
  const url = `https://api.openalex.org/works?per-page=5&search=${encodeURIComponent(title)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.results || []).map((item) => normalizeCandidate({
    title: item.title || '',
    year: item.publication_year || '',
    venue: item.primary_location?.source?.display_name || '',
    source: 'OpenAlex',
    authors: (item.authorships || []).map((authorship) => authorship.author?.display_name).filter(Boolean),
    institutions: Array.from(new Set((item.authorships || []).flatMap((authorship) =>
      (authorship.institutions || []).map((institution) => institution.display_name)
    ).filter(Boolean))),
    abstract: invertedIndexToText(item.abstract_inverted_index),
    doi: item.doi ? item.doi.replace(/^https:\/\/doi.org\//i, '') : '',
    arxiv_id: extractArxivId(item.doi || ''),
    openreview_id: '',
    url: item.primary_location?.landing_page_url || item.id || '',
    confidence: similarityScore(title, item.title || '')
  }));
}

export function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.doi || candidate.arxiv_id || candidate.openreview_id || candidate.canonical_url || normalizeTitle(candidate.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result.sort((a, b) => b.confidence - a.confidence);
}

export async function getCachedMetadata(env, key, type) {
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT result_json, created_at FROM metadata_cache WHERE query = ?').bind(key).first();
  if (!row) return null;
  const ttlDays = type === 'title' ? 7 : 30;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > ttlDays * 24 * 60 * 60 * 1000) return null;
  try {
    return JSON.parse(row.result_json);
  } catch {
    return null;
  }
}

export async function putCachedMetadata(env, key, result) {
  if (!env.DB || !key) return;
  await env.DB.prepare(
    'INSERT INTO metadata_cache (query, result_json, created_at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at'
  ).bind(key, JSON.stringify(result), new Date().toISOString()).run();
}

function textFromXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1].replace(/\s+/g, ' ').trim()) : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function invertedIndexToText(index) {
  if (!index) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(' ');
}
```

- [ ] **Step 2: Add Worker route imports**

In `webapp/src/worker.js`, add:

```js
import { detectDuplicate, searchMetadata } from './metadata.js';
```

- [ ] **Step 3: Add metadata route to Worker**

Inside `handleApi`, before the paper route match, add:

```js
if (request.method === 'POST' && url.pathname === '/api/metadata/search') {
  return searchMetadataRoute(request, env);
}
```

Add this function near other API handlers:

```js
async function searchMetadataRoute(request, env) {
  const data = await readJson(request);
  const query = String(data.query || '').trim();
  if (!query) return json({ error: 'Query is required' }, 400);

  const result = await searchMetadata(query, env, { bypassCache: data.bypassCache === true });
  const existing = await env.DB.prepare(
    'SELECT id, title, doi, arxiv_id, openreview_id, canonical_url FROM papers'
  ).all();

  const candidates = result.candidates.map((candidate) => ({
    ...candidate,
    duplicate: detectDuplicate(candidate, existing.results || [])
  }));

  return json({ ...result, candidates });
}
```

- [ ] **Step 4: Run syntax checks**

Run:

```bash
node --check webapp/src/metadata.js
node --check webapp/src/worker.js
```

Expected: no syntax errors.

- [ ] **Step 5: Run unit tests**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
npm test
```

Expected: PASS.

- [ ] **Step 6: Run local Worker endpoint**

Start local Worker:

```bash
wrangler dev --persist-to=.wrangler/state --ip 127.0.0.1 --port 8787
```

In another terminal, run:

```bash
curl -s -X POST http://127.0.0.1:8787/api/metadata/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"2401.12345"}'
```

Expected: JSON response with `queryType`, `candidates`, and `fromCache`. The specific candidate count depends on whether the ID exists and whether external API access works.

- [ ] **Step 7: Commit**

If git is available:

```bash
git add webapp/src/metadata.js webapp/src/worker.js webapp/test/metadata.test.mjs
git commit -m "feat: add metadata search endpoint"
```

Otherwise skip and record that commit was not possible.

---

### Task 5: Add Comments API

**Files:**
- Create: `webapp/src/comments.js`
- Modify: `webapp/src/worker.js`

- [ ] **Step 1: Create comments handlers**

Create `webapp/src/comments.js`:

```js
export async function listComments(env, paperId) {
  const result = await env.DB.prepare(
    'SELECT * FROM comments WHERE paper_id = ? ORDER BY created_at ASC'
  ).bind(paperId).all();
  return result.results.map(normalizeComment);
}

export async function createComment(request, env, paperId) {
  const data = await request.json().catch(() => ({}));
  const author = String(data.author || '').trim();
  const content = String(data.content || '').trim();
  const type = normalizeType(data.type);
  const parentId = String(data.parent_id || '').trim();

  if (!author) return responseJson({ error: 'Author is required' }, 400);
  if (!content) return responseJson({ error: 'Content is required' }, 400);

  if (parentId) {
    const parent = await env.DB.prepare(
      'SELECT id, parent_id FROM comments WHERE id = ? AND paper_id = ?'
    ).bind(parentId, paperId).first();
    if (!parent) return responseJson({ error: 'Parent comment not found' }, 404);
    if (parent.parent_id) return responseJson({ error: 'Replies cannot be nested more than one level' }, 400);
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO comments (id, paper_id, parent_id, author, type, content, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, paperId, parentId, author, type, content, '否', now, now).run();

  const row = await env.DB.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first();
  return responseJson(normalizeComment(row), 201);
}

export async function updateComment(request, env, commentId) {
  const data = await request.json().catch(() => ({}));
  const content = String(data.content || '').trim();
  const type = normalizeType(data.type);
  if (!content) return responseJson({ error: 'Content is required' }, 400);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'UPDATE comments SET content = ?, type = ?, updated_at = ? WHERE id = ? AND deleted != ?'
  ).bind(content, type, now, commentId, '是').run();

  if (result.meta.changes === 0) return responseJson({ error: 'Comment not found' }, 404);
  const row = await env.DB.prepare('SELECT * FROM comments WHERE id = ?').bind(commentId).first();
  return responseJson(normalizeComment(row));
}

export async function deleteComment(env, commentId) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'UPDATE comments SET deleted = ?, content = ?, updated_at = ? WHERE id = ?'
  ).bind('是', '', now, commentId).run();

  if (result.meta.changes === 0) return responseJson({ error: 'Comment not found' }, 404);
  return responseJson({ success: true });
}

export function normalizeComment(row) {
  return {
    id: row.id,
    paper_id: row.paper_id,
    parent_id: row.parent_id || '',
    author: row.author || '',
    type: row.type || '其他',
    content: row.deleted === '是' ? '' : row.content || '',
    deleted: row.deleted || '否',
    created_at: row.created_at || '',
    updated_at: row.updated_at || ''
  };
}

function normalizeType(value) {
  const allowed = new Set(['问题', '启发', '复现', '补充资料', '其他']);
  const type = String(value || '其他').trim();
  return allowed.has(type) ? type : '其他';
}

function responseJson(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}
```

- [ ] **Step 2: Import comments handlers in Worker**

In `webapp/src/worker.js`, add:

```js
import {
  createComment,
  deleteComment,
  listComments,
  updateComment
} from './comments.js';
```

- [ ] **Step 3: Add comment routes to Worker**

Inside `handleApi`, after metadata route and before paper update routes, add:

```js
const commentsMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/comments$/);
if (commentsMatch && request.method === 'GET') {
  return json({ comments: await listComments(env, commentsMatch[1]) });
}
if (commentsMatch && request.method === 'POST') {
  return createComment(request, env, commentsMatch[1]);
}

const commentMatch = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
if (commentMatch && request.method === 'PUT') {
  return updateComment(request, env, commentMatch[1]);
}
if (commentMatch && request.method === 'DELETE') {
  return deleteComment(env, commentMatch[1]);
}
```

- [ ] **Step 4: Check syntax**

Run:

```bash
node --check webapp/src/comments.js
node --check webapp/src/worker.js
```

Expected: no syntax errors.

- [ ] **Step 5: Verify local comments API**

Start Wrangler locally and run:

```bash
curl -s -X POST http://127.0.0.1:8787/api/papers \
  -H 'Content-Type: application/json' \
  -d '{"title":"Comment Test","categories":["VLA 与机器人基础模型"],"updated_by":"测试成员"}'
```

Copy the returned `id`, then run:

```bash
curl -s -X POST http://127.0.0.1:8787/api/papers/<paper-id>/comments \
  -H 'Content-Type: application/json' \
  -d '{"author":"测试成员","type":"问题","content":"这是一条顶层评论"}'
```

Copy the returned comment `id`, then run:

```bash
curl -s -X POST http://127.0.0.1:8787/api/papers/<paper-id>/comments \
  -H 'Content-Type: application/json' \
  -d '{"parent_id":"<comment-id>","author":"测试成员2","type":"启发","content":"这是一条回复"}'
```

Then run:

```bash
curl -s http://127.0.0.1:8787/api/papers/<paper-id>/comments
```

Expected: response contains two comments, one with empty `parent_id` and one with `parent_id` equal to the first comment ID.

- [ ] **Step 6: Commit**

If git is available:

```bash
git add webapp/src/comments.js webapp/src/worker.js
git commit -m "feat: add paper discussion API"
```

Otherwise skip and record that commit was not possible.

---

### Task 6: Add Metadata Fields to Local Flask Compatibility Layer

**Files:**
- Modify: `webapp/server.py`

- [ ] **Step 1: Add metadata fields to Python `FIELDS`**

In `webapp/server.py`, ensure `FIELDS` includes these entries before `created_by`:

```python
'abstract',
'doi',
'arxiv_id',
'openreview_id',
'metadata_source',
'metadata_checked_at',
'canonical_url',
```

- [ ] **Step 2: Add columns in `init_db()`**

In `extra_columns`, add:

```python
'abstract': 'TEXT',
'doi': 'TEXT',
'arxiv_id': 'TEXT',
'openreview_id': 'TEXT',
'metadata_source': 'TEXT',
'metadata_checked_at': 'TEXT',
'canonical_url': 'TEXT'
```

- [ ] **Step 3: Add local comments table**

In `init_db()`, after the `papers` table migration logic, execute:

```python
conn.execute('''
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
    )
''')
conn.execute('CREATE INDEX IF NOT EXISTS idx_comments_paper_id ON comments(paper_id)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at)')
```

- [ ] **Step 4: Add local comments endpoints**

Add Flask routes equivalent to the Worker comments API:

```python
@app.route('/api/papers/<paper_id>/comments', methods=['GET'])
@require_auth
def list_comments(paper_id):
    conn = get_db()
    rows = conn.execute('SELECT * FROM comments WHERE paper_id = ? ORDER BY created_at ASC', (paper_id,)).fetchall()
    conn.close()
    return jsonify({'comments': [dict(r) for r in rows]})

@app.route('/api/papers/<paper_id>/comments', methods=['POST'])
@require_auth
def create_comment(paper_id):
    data = request.get_json(force=True) or {}
    author = (data.get('author') or '').strip()
    content = (data.get('content') or '').strip()
    comment_type = data.get('type') or '其他'
    parent_id = (data.get('parent_id') or '').strip()
    if not author:
        return jsonify({'error': 'Author is required'}), 400
    if not content:
        return jsonify({'error': 'Content is required'}), 400
    now = datetime.now().isoformat()
    comment_id = secrets.token_hex(8)
    conn = get_db()
    conn.execute(
        'INSERT INTO comments (id, paper_id, parent_id, author, type, content, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (comment_id, paper_id, parent_id, author, comment_type, content, '否', now, now)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM comments WHERE id = ?', (comment_id,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201

@app.route('/api/comments/<comment_id>', methods=['PUT'])
@require_auth
def update_comment(comment_id):
    data = request.get_json(force=True) or {}
    content = (data.get('content') or '').strip()
    comment_type = data.get('type') or '其他'
    if not content:
        return jsonify({'error': 'Content is required'}), 400
    now = datetime.now().isoformat()
    conn = get_db()
    conn.execute('UPDATE comments SET content = ?, type = ?, updated_at = ? WHERE id = ? AND deleted != ?', (content, comment_type, now, comment_id, '是'))
    conn.commit()
    row = conn.execute('SELECT * FROM comments WHERE id = ?', (comment_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Comment not found'}), 404
    return jsonify(dict(row))

@app.route('/api/comments/<comment_id>', methods=['DELETE'])
@require_auth
def delete_comment(comment_id):
    now = datetime.now().isoformat()
    conn = get_db()
    conn.execute('UPDATE comments SET deleted = ?, content = ?, updated_at = ? WHERE id = ?', ('是', '', now, comment_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})
```

- [ ] **Step 5: Check Python syntax**

Run:

```bash
python3 -m py_compile webapp/server.py
```

Expected: no output and exit code `0`.

- [ ] **Step 6: Commit**

If git is available:

```bash
git add webapp/server.py
git commit -m "feat: keep local server compatible with comments"
```

Otherwise skip and record that commit was not possible.

---

### Task 7: Add Quick Identify UI to `index.html`

**Files:**
- Modify: `webapp/index.html`

- [ ] **Step 1: Add CSS for metadata identify UI**

Add this CSS near the form styles:

```css
.identify-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f8fafc;
  padding: 14px;
  margin-bottom: 20px;
}
.identify-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.identify-row input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
}
.candidate-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
.candidate-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.candidate-card.duplicate {
  border-color: var(--warning);
  background: #fffbeb;
}
.candidate-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
.candidate-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.candidate-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
```

- [ ] **Step 2: Add metadata fields to empty paper**

In `createEmptyPaper()`, add:

```js
abstract: '',
doi: '',
arxiv_id: '',
openreview_id: '',
metadata_source: '',
metadata_checked_at: '',
canonical_url: '',
```

- [ ] **Step 3: Add app state for identify results**

Inside `const app = { ... }`, add:

```js
identifyCandidates: [],
identifyMessage: '',
identifyLoading: false,
```

- [ ] **Step 4: Render quick identify panel**

At the beginning of `renderEditorForm(p)`, before the score section, add:

```js
html += this.renderIdentifyPanel();
```

Add this method:

```js
renderIdentifyPanel() {
  return `
    <div class="identify-panel">
      <div class="form-section-title">快速识别</div>
      <div class="identify-row">
        <input type="text" id="identify-query" placeholder="粘贴 arXiv / DOI / OpenReview / 论文标题">
        <button class="btn btn-secondary" type="button" onclick="app.searchMetadata()" ${this.identifyLoading ? 'disabled' : ''}>${this.identifyLoading ? '识别中...' : '识别'}</button>
        <button class="btn btn-secondary" type="button" onclick="app.clearMetadataResults()">清空结果</button>
      </div>
      ${this.identifyMessage ? `<div class="field-hint" style="margin-top:8px;">${this.escape(this.identifyMessage)}</div>` : ''}
      <div class="candidate-list" id="candidate-list">
        ${this.identifyCandidates.map((candidate, index) => this.renderCandidateCard(candidate, index)).join('')}
      </div>
    </div>
  `;
}
```

- [ ] **Step 5: Render candidate cards**

Add this method:

```js
renderCandidateCard(candidate, index) {
  const duplicate = candidate.duplicate || {status:'none'};
  const duplicateText = duplicate.status === 'definite'
    ? `已存在相同论文（${duplicate.reason}）`
    : duplicate.status === 'suspected'
      ? '可能已存在相似论文'
      : '';
  return `
    <div class="candidate-card ${duplicate.status !== 'none' ? 'duplicate' : ''}">
      <div class="candidate-title">${this.escape(candidate.title || '未命名结果')}</div>
      <div class="candidate-meta">
        ${this.escape([candidate.year, candidate.venue, candidate.source].filter(Boolean).join(' · '))}<br>
        ${this.escape(candidate.authors || '')}<br>
        ${candidate.doi ? `DOI: ${this.escape(candidate.doi)} ` : ''}
        ${candidate.arxiv_id ? `arXiv: ${this.escape(candidate.arxiv_id)} ` : ''}
        ${candidate.openreview_id ? `OpenReview: ${this.escape(candidate.openreview_id)}` : ''}
        ${duplicateText ? `<br><strong>${this.escape(duplicateText)}</strong>` : ''}
      </div>
      ${candidate.abstract ? `<div class="candidate-meta">${this.escape(candidate.abstract).slice(0, 220)}${candidate.abstract.length > 220 ? '...' : ''}</div>` : ''}
      <div class="candidate-actions">
        <button class="btn btn-primary btn-sm" type="button" onclick="app.applyMetadataCandidate(${index})">使用此结果</button>
        ${duplicate.paper ? `<button class="btn btn-secondary btn-sm" type="button" onclick="app.openDetail('${duplicate.paper.id}')">打开已有记录</button>` : ''}
        ${duplicate.paper ? `<button class="btn btn-secondary btn-sm" type="button" onclick="app.mergeMetadataIntoExisting(${index})">合并到已有记录</button>` : ''}
      </div>
    </div>
  `;
}
```

- [ ] **Step 6: Implement search and clear methods**

Add:

```js
async searchMetadata() {
  const input = document.getElementById('identify-query');
  const query = input ? input.value.trim() : '';
  if (!query) {
    this.identifyMessage = '请输入链接、DOI、arXiv ID、OpenReview 链接或论文标题。';
    this.refreshEditor();
    return;
  }
  this.identifyLoading = true;
  this.identifyMessage = '正在识别...';
  this.refreshEditor();
  try {
    const result = await apiPost('/api/metadata/search', {query});
    this.identifyCandidates = result.candidates || [];
    this.identifyMessage = this.identifyCandidates.length
      ? `找到 ${this.identifyCandidates.length} 个候选结果。`
      : '未找到可靠结果，请手动填写。';
  } catch (e) {
    this.identifyCandidates = [];
    this.identifyMessage = '识别服务暂时不可用，请手动填写。';
  } finally {
    this.identifyLoading = false;
    this.refreshEditor();
  }
},

clearMetadataResults() {
  this.identifyCandidates = [];
  this.identifyMessage = '';
  const input = document.getElementById('identify-query');
  if (input) input.value = '';
  this.refreshEditor();
},

refreshEditor() {
  if (this.modalMode !== 'edit') return;
  const id = this.editingId;
  const p = id ? this.collectFormPaper(this.papers.find(x => x.id === id) || createEmptyPaper()) : this.collectFormPaper(createEmptyPaper());
  document.getElementById('modal-body').innerHTML = this.renderEditorForm(p);
  this.attachFormDirtyTracking();
}
```

- [ ] **Step 7: Add a form collection helper**

Extract the field-reading logic from `savePaper()` into:

```js
collectFormPaper(basePaper) {
  const p = {...basePaper};
  ['relevance','novelty','evidence','inspiration','reproducibility'].forEach(k => {
    const el = document.getElementById('score-' + k);
    if (el) p[k] = parseFloat(el.value) || 0;
  });
  FIELDS_DEF.forEach(f => {
    const el = document.getElementById('field-' + f.key);
    if (el) p[f.key] = el.value;
  });
  const categories = Array.from(document.querySelectorAll('input[name="field-categories"]:checked')).map(el => el.value);
  p.categories = categories;
  p.category = categories[0] || p.category || CATEGORIES[0];
  p.tags = parseList(document.getElementById('field-tags')?.value || '');
  return p;
}
```

Then update `savePaper()` to use `this.collectFormPaper(p)`.

- [ ] **Step 8: Check frontend script syntax**

Run:

```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('webapp/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); fs.writeFileSync('/tmp/embodied-inline.js', m[1]);"
node --check /tmp/embodied-inline.js
```

Expected: no syntax errors.

- [ ] **Step 9: Commit**

If git is available:

```bash
git add webapp/index.html
git commit -m "feat: add quick metadata identify UI"
```

Otherwise skip and record that commit was not possible.

---

### Task 8: Apply Metadata Candidate and Display Metadata in Details

**Files:**
- Modify: `webapp/index.html`

- [ ] **Step 1: Add metadata application helper**

Add this method:

```js
applyMetadataCandidate(index) {
  const candidate = this.identifyCandidates[index];
  if (!candidate) return;
  const fieldMap = {
    title: candidate.title,
    source: [candidate.year, candidate.venue].filter(Boolean).join(' / '),
    link: candidate.url || candidate.canonical_url,
    authors: [candidate.authors, candidate.institutions].filter(Boolean).join('\n')
  };
  for (const [field, value] of Object.entries(fieldMap)) {
    if (!value) continue;
    const el = document.getElementById('field-' + field);
    if (!el) continue;
    if (el.value && el.value !== value) {
      if (confirm(`${field} 已有内容，是否用识别结果覆盖？`)) el.value = value;
    } else {
      el.value = value;
    }
  }
  this.currentMetadata = {
    abstract: candidate.abstract || '',
    doi: candidate.doi || '',
    arxiv_id: candidate.arxiv_id || '',
    openreview_id: candidate.openreview_id || '',
    metadata_source: candidate.source || '',
    metadata_checked_at: new Date().toISOString(),
    canonical_url: candidate.canonical_url || candidate.url || ''
  };
  this.markFormDirty();
  this.identifyMessage = '识别结果已填入表单，请检查后点击保存。';
  this.refreshEditor();
}
```

- [ ] **Step 2: Add metadata fields to `collectFormPaper()`**

At the end of `collectFormPaper(basePaper)`, add:

```js
if (this.currentMetadata) {
  Object.assign(p, this.currentMetadata);
}
```

- [ ] **Step 3: Initialize metadata state in `openEditor()`**

In `openEditor(id)`, after selecting `p`, set:

```js
this.currentMetadata = {
  abstract: p.abstract || '',
  doi: p.doi || '',
  arxiv_id: p.arxiv_id || '',
  openreview_id: p.openreview_id || '',
  metadata_source: p.metadata_source || '',
  metadata_checked_at: p.metadata_checked_at || '',
  canonical_url: p.canonical_url || ''
};
```

- [ ] **Step 4: Display metadata in detail view**

In `renderDetailBody(p)`, after the basic information section, add:

```js
${this.renderMetadataSection(p)}
```

Add:

```js
renderMetadataSection(p) {
  const hasMetadata = p.abstract || p.doi || p.arxiv_id || p.openreview_id || p.canonical_url || p.metadata_source;
  if (!hasMetadata) return '';
  return `
    <div class="detail-section">
      <h4>元数据</h4>
      ${p.abstract ? `<p><strong>摘要：</strong>${this.nl2br(this.escape(p.abstract))}</p>` : ''}
      <p>
        ${p.doi ? `<strong>DOI：</strong>${this.escape(p.doi)}<br>` : ''}
        ${p.arxiv_id ? `<strong>arXiv：</strong>${this.escape(p.arxiv_id)}<br>` : ''}
        ${p.openreview_id ? `<strong>OpenReview：</strong>${this.escape(p.openreview_id)}<br>` : ''}
        ${p.canonical_url ? `<strong>Canonical URL：</strong>${this.escape(p.canonical_url)}<br>` : ''}
        ${p.metadata_source ? `<strong>来源：</strong>${this.escape(p.metadata_source)}<br>` : ''}
        ${p.metadata_checked_at ? `<strong>识别时间：</strong>${this.escape(p.metadata_checked_at).slice(0,16).replace('T',' ')}` : ''}
      </p>
    </div>
  `;
}
```

- [ ] **Step 5: Implement merge into existing record**

Add:

```js
async mergeMetadataIntoExisting(index) {
  const candidate = this.identifyCandidates[index];
  const paper = candidate?.duplicate?.paper;
  if (!candidate || !paper) return;
  if (!confirm('确认只把事实元数据合并到已有记录？不会覆盖评分、分类、标签和深读内容。')) return;
  try {
    await apiPost('/api/papers/' + paper.id + '/metadata', {
      metadata: candidate,
      updated_by: this.getMemberName(true)
    });
    await this.loadData();
    this.saveData();
    alert('元数据已合并到已有记录。');
    this.openDetail(paper.id);
  } catch (e) {
    alert('合并失败：' + e.message);
  }
}
```

- [ ] **Step 6: Add Worker route for metadata merge**

In `worker.js`, add route:

```js
const metadataApplyMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/metadata$/);
if (metadataApplyMatch && request.method === 'POST') {
  return applyPaperMetadata(request, env, metadataApplyMatch[1]);
}
```

Add handler:

```js
async function applyPaperMetadata(request, env, id) {
  const data = await readJson(request);
  const metadata = data.metadata || {};
  const current = await env.DB.prepare('SELECT * FROM papers WHERE id = ?').bind(id).first();
  if (!current) return json({ error: 'Not found' }, 404);
  const now = new Date().toISOString();
  const updated = normalizePaper({
    ...current,
    title: current.title || metadata.title || '',
    source: current.source || [metadata.year, metadata.venue].filter(Boolean).join(' / '),
    link: current.link || metadata.url || metadata.canonical_url || '',
    authors: current.authors || [metadata.authors, metadata.institutions].filter(Boolean).join('\n'),
    abstract: metadata.abstract || current.abstract || '',
    doi: metadata.doi || current.doi || '',
    arxiv_id: metadata.arxiv_id || current.arxiv_id || '',
    openreview_id: metadata.openreview_id || current.openreview_id || '',
    metadata_source: metadata.source || current.metadata_source || '',
    metadata_checked_at: now,
    canonical_url: metadata.canonical_url || metadata.url || current.canonical_url || '',
    updated_by: normalizeActor(data.updated_by),
    updated_at: now
  });
  const fields = FIELDS.filter((field) => field !== 'id' && field !== 'created_at');
  const sets = fields.map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => updated[field]);
  await env.DB.prepare(`UPDATE papers SET ${sets} WHERE id = ?`).bind(...values, id).run();
  const row = await env.DB.prepare('SELECT * FROM papers WHERE id = ?').bind(id).first();
  return json(normalizeRow(row));
}
```

- [ ] **Step 7: Run checks**

Run:

```bash
node --check webapp/src/worker.js
node -e "const fs=require('fs'); const html=fs.readFileSync('webapp/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); fs.writeFileSync('/tmp/embodied-inline.js', m[1]);"
node --check /tmp/embodied-inline.js
```

Expected: no syntax errors.

- [ ] **Step 8: Commit**

If git is available:

```bash
git add webapp/index.html webapp/src/worker.js
git commit -m "feat: apply and display paper metadata"
```

Otherwise skip and record that commit was not possible.

---

### Task 9: Add Discussion UI

**Files:**
- Modify: `webapp/index.html`

- [ ] **Step 1: Add discussion CSS**

Add:

```css
.discussion {
  margin-top: 28px;
  border-top: 1px solid var(--border);
  padding-top: 20px;
}
.comment-editor {
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.comment-editor textarea {
  width: 100%;
  min-height: 76px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
}
.comment-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.comment {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
  background: #fff;
}
.comment.reply {
  margin-left: 28px;
  background: #f8fafc;
}
.comment-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.comment-content {
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}
```

- [ ] **Step 2: Add app comment state**

Inside `app`, add:

```js
comments: [],
commentsLoading: false,
replyingTo: '',
```

- [ ] **Step 3: Load comments when opening detail**

In `openDetail(id)`, after rendering radar, call:

```js
this.loadComments(id);
```

Add:

```js
async loadComments(paperId) {
  this.commentsLoading = true;
  this.renderComments(paperId);
  try {
    const data = await apiGet('/api/papers/' + paperId + '/comments');
    this.comments = data.comments || [];
  } catch (e) {
    this.comments = [];
  } finally {
    this.commentsLoading = false;
    this.renderComments(paperId);
  }
}
```

- [ ] **Step 4: Add discussion placeholder to detail body**

At the end of `renderDetailBody(p)`, before closing the root template, add:

```html
<div class="discussion" id="discussion-root"></div>
```

- [ ] **Step 5: Render comments**

Add:

```js
renderComments(paperId) {
  const root = document.getElementById('discussion-root');
  if (!root) return;
  const topLevel = this.comments.filter(c => !c.parent_id);
  const repliesByParent = this.comments.reduce((acc, comment) => {
    if (comment.parent_id) {
      if (!acc[comment.parent_id]) acc[comment.parent_id] = [];
      acc[comment.parent_id].push(comment);
    }
    return acc;
  }, {});
  root.innerHTML = `
    <h4 style="font-size:14px;margin-bottom:10px;">讨论区</h4>
    ${this.renderCommentEditor(paperId, '')}
    ${this.commentsLoading ? '<div class="field-hint">正在加载评论...</div>' : ''}
    ${topLevel.length ? topLevel.map(comment => `
      ${this.renderComment(comment, paperId)}
      ${(repliesByParent[comment.id] || []).map(reply => this.renderComment(reply, paperId, true)).join('')}
      ${this.replyingTo === comment.id ? this.renderCommentEditor(paperId, comment.id) : ''}
    `).join('') : '<div class="field-hint">暂无讨论，写下第一个问题或补充资料。</div>'}
  `;
}
```

- [ ] **Step 6: Add comment editor and comment item renderers**

Add:

```js
renderCommentEditor(paperId, parentId) {
  const suffix = parentId || 'root';
  return `
    <div class="comment-editor">
      <textarea id="comment-content-${suffix}" placeholder="${parentId ? '回复这条讨论...' : '写下问题、启发、复现实验记录或补充资料...'}"></textarea>
      <div class="comment-toolbar">
        <select id="comment-type-${suffix}" class="sort-select">
          ${['问题','启发','复现','补充资料','其他'].map(type => `<option value="${type}">${type}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" onclick="app.postComment('${paperId}', '${parentId}')">${parentId ? '发布回复' : '发布评论'}</button>
        ${parentId ? `<button class="btn btn-secondary btn-sm" onclick="app.cancelReply('${paperId}')">取消</button>` : ''}
      </div>
    </div>
  `;
},

renderComment(comment, paperId, isReply = false) {
  const deleted = comment.deleted === '是';
  return `
    <div class="comment ${isReply ? 'reply' : ''}">
      <div class="comment-meta">
        <span class="tag gray">${this.escape(comment.type || '其他')}</span>
        ${this.escape(comment.author || '匿名')} · ${this.escape((comment.created_at || '').slice(0,16).replace('T',' '))}
      </div>
      <div class="comment-content">${deleted ? '该评论已删除' : this.nl2br(this.escape(comment.content || ''))}</div>
      ${deleted ? '' : `
        <div class="candidate-actions">
          ${isReply ? '' : `<button class="btn btn-secondary btn-sm" onclick="app.startReply('${paperId}', '${comment.id}')">回复</button>`}
          <button class="btn btn-danger btn-sm" onclick="app.deleteComment('${paperId}', '${comment.id}')">删除</button>
        </div>
      `}
    </div>
  `;
}
```

- [ ] **Step 7: Add comment actions**

Add:

```js
async postComment(paperId, parentId) {
  const suffix = parentId || 'root';
  const contentEl = document.getElementById('comment-content-' + suffix);
  const typeEl = document.getElementById('comment-type-' + suffix);
  const content = contentEl ? contentEl.value.trim() : '';
  if (!content) {
    alert('请输入评论内容。');
    return;
  }
  const author = this.getMemberName(true);
  if (!author) return;
  try {
    await apiPost('/api/papers/' + paperId + '/comments', {
      parent_id: parentId,
      author,
      type: typeEl ? typeEl.value : '其他',
      content
    });
    this.replyingTo = '';
    await this.loadComments(paperId);
  } catch (e) {
    alert('评论发布失败：' + e.message);
  }
},

startReply(paperId, commentId) {
  this.replyingTo = commentId;
  this.renderComments(paperId);
},

cancelReply(paperId) {
  this.replyingTo = '';
  this.renderComments(paperId);
},

async deleteComment(paperId, commentId) {
  if (!confirm('确定删除这条评论吗？')) return;
  try {
    await apiDelete('/api/comments/' + commentId);
    await this.loadComments(paperId);
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}
```

- [ ] **Step 8: Run frontend syntax check**

Run:

```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('webapp/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); fs.writeFileSync('/tmp/embodied-inline.js', m[1]);"
node --check /tmp/embodied-inline.js
```

Expected: no syntax errors.

- [ ] **Step 9: Commit**

If git is available:

```bash
git add webapp/index.html
git commit -m "feat: add threaded discussion UI"
```

Otherwise skip and record that commit was not possible.

---

### Task 10: End-to-End Local Verification

**Files:**
- No file edits expected.

- [ ] **Step 1: Run syntax checks**

Run:

```bash
node --check webapp/src/paper-utils.js
node --check webapp/src/metadata.js
node --check webapp/src/comments.js
node --check webapp/src/worker.js
python3 -m py_compile webapp/server.py
node -e "const fs=require('fs'); const html=fs.readFileSync('webapp/index.html','utf8'); const m=html.match(/<script>([\\s\\S]*)<\\/script>/); fs.writeFileSync('/tmp/embodied-inline.js', m[1]);"
node --check /tmp/embodied-inline.js
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run unit tests**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
npm test
```

Expected: PASS.

- [ ] **Step 3: Start local Worker**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
wrangler dev --persist-to=.wrangler/state --ip 127.0.0.1 --port 8787
```

Expected: Wrangler prints `Ready on http://127.0.0.1:8787`.

- [ ] **Step 4: Verify homepage**

Run:

```bash
curl -s -o /tmp/embodied-index.html -w '%{http_code}' http://127.0.0.1:8787/
```

Expected: `200`.

- [ ] **Step 5: Verify comments API**

Create a paper and comment using the commands from Task 5 Step 5.

Expected:

- Paper create returns `201`.
- Comment create returns `201`.
- Comment list includes created comments.

- [ ] **Step 6: Verify metadata API**

Run:

```bash
curl -s -X POST http://127.0.0.1:8787/api/metadata/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Attention Is All You Need"}'
```

Expected: JSON response contains `candidates`. Candidate count depends on external API availability.

- [ ] **Step 7: Stop local Worker**

In the Wrangler terminal, press:

```text
x
```

Expected: local server shuts down cleanly.

---

### Task 11: Remote Migration and Cloudflare Deploy

**Files:**
- No source edits expected.

- [ ] **Step 1: Apply remote D1 migration**

Run:

```bash
cd /Users/yangfeiyang/Desktop/Work_Space/文献阅读记录/webapp
npm run d1:migrate:remote
```

Expected: `0003_metadata_comments.sql` shows status `✅`.

- [ ] **Step 2: Deploy Worker**

Run:

```bash
npm run deploy
```

Expected: Wrangler prints deployed URL:

```text
https://embodied-papers-team.yangfeiyang-papers.workers.dev
```

- [ ] **Step 3: Verify live homepage**

Run:

```bash
curl -s -o /tmp/embodied-live-index.html -w '%{http_code}' https://embodied-papers-team.yangfeiyang-papers.workers.dev/
```

Expected: `200`.

- [ ] **Step 4: Verify live API auth remains active**

Run:

```bash
curl -s -o /tmp/embodied-live-api.json -w '%{http_code}' https://embodied-papers-team.yangfeiyang-papers.workers.dev/api/papers
```

Expected: `401` if `APP_PASSWORD` is set. This is correct and means password protection is active.

- [ ] **Step 5: Manual browser smoke test**

Open:

```text
https://embodied-papers-team.yangfeiyang-papers.workers.dev
```

Verify:

- Password prompt works.
- Member name button works.
- Add paper opens modal.
- Quick identify area is visible.
- Manual save still works.
- Paper detail opens.
- Discussion area is visible.
- Posting a comment works after entering member name.

---

## Self-Review Notes

- Spec coverage:
  - Metadata recognition is covered by Tasks 3, 4, 7, and 8.
  - Duplicate detection is covered by Tasks 3, 4, 7, and 8.
  - Metadata persistence is covered by Tasks 1, 2, 6, and 8.
  - Threaded discussions are covered by Tasks 1, 5, 6, and 9.
  - Local and remote verification are covered by Tasks 10 and 11.

- Placeholder scan:
  - The plan uses concrete file paths, SQL, JavaScript, Python route code, and commands.
  - There are no `TODO`, `TBD`, or unspecified implementation steps.

- Type consistency:
  - Metadata fields use `abstract`, `doi`, `arxiv_id`, `openreview_id`, `metadata_source`, `metadata_checked_at`, and `canonical_url` consistently.
  - Comment fields use `id`, `paper_id`, `parent_id`, `author`, `type`, `content`, `deleted`, `created_at`, and `updated_at` consistently.
  - Frontend APIs match Worker routes.
