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
  'favorite',
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

const IDENTIFIER_FIELDS = new Set([
  'doi',
  'arxiv_id',
  'openreview_id'
]);

const URL_FIELDS = new Set([
  'canonical_url'
]);

const INSERT_VERBS = new Set([
  'INSERT',
  'INSERT OR IGNORE'
]);

export function parseList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
  }
  if (!value) return [];
  return Array.from(new Set(String(value).split(/[|,，;；\n]+/).map((item) => item.trim()).filter(Boolean)));
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
  if (IDENTIFIER_FIELDS.has(field)) {
    return normalizeIdentifier(value);
  }
  if (URL_FIELDS.has(field)) {
    return normalizeUrl(value);
  }
  return value ?? '';
}

export function normalizeIdentifier(value) {
  return String(value || '').trim();
}

export function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    const host = url.host.toLowerCase();
    const pathname = removeTrailingSlash(url.pathname);
    const search = normalizeSearch(url.searchParams);
    return `${protocol}//${host}${pathname}${search}`;
  } catch {
    return removeTrailingSlash(trimmed);
  }
}

function normalizeSearch(searchParams) {
  const entries = Array.from(searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = leftKey.localeCompare(rightKey);
    if (keyCompare !== 0) return keyCompare;
    return leftValue.localeCompare(rightValue);
  });

  const sorted = new URLSearchParams(entries);
  const query = sorted.toString();
  return query ? `?${query}` : '';
}

function removeTrailingSlash(value) {
  if (value === '/') return '';
  return value.replace(/\/+$/g, '');
}

export function insertPaperStatement(env, paper, verb = 'INSERT') {
  if (!INSERT_VERBS.has(verb)) {
    throw new Error(`Unsupported insert verb: ${verb}`);
  }

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
