import { normalizeUrl } from './paper-utils.js';

const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s<>"{}|\\^`]+/i;
const ARXIV_ID_PATTERN = /\b(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b/i;
const ARXIV_URL_PATTERN = /(?:^|\.)arxiv\.org$/i;
const OPENREVIEW_URL_PATTERN = /(?:^|\.)openreview\.net$/i;
const LIST_FIELDS = new Set(['authors', 'institutions']);
const DEFAULT_TITLE_THRESHOLD = 0.82;
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

export function classifyMetadataQuery(value) {
  const query = String(value || '').trim();
  if (!query) return { type: 'unknown', value: '' };

  const openreviewId = extractOpenReviewId(query);
  if (openreviewId) {
    return { type: 'openreview', value: openreviewId };
  }

  if (isArxivUrl(query)) {
    const arxivId = extractArxivId(query);
    if (arxivId) return { type: 'arxiv', value: arxivId };
  }

  const doi = extractDoi(query);
  if (doi) {
    return { type: 'doi', value: doi };
  }

  const arxivId = extractArxivId(query);
  if (arxivId) {
    return { type: 'arxiv', value: arxivId };
  }

  return { type: 'title', value: query };
}

export function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function similarityScore(left, right) {
  const leftTitle = normalizeTitle(left);
  const rightTitle = normalizeTitle(right);
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle === rightTitle) return 1;

  const tokenScore = diceScore(tokenSet(leftTitle), tokenSet(rightTitle));
  const characterScore = diceScore(bigrams(leftTitle), bigrams(rightTitle));
  return roundScore((tokenScore * 0.65) + (characterScore * 0.35));
}

export function extractArxivId(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const arxivUrlId = parseUrl(text, (url) => {
    if (!ARXIV_URL_PATTERN.test(url.hostname)) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    const rawId = parts[parts.length - 1].replace(/\.pdf$/i, '');
    return normalizeArxivId(rawId);
  });
  if (arxivUrlId) return arxivUrlId;

  const doiArxivMatch = text.match(/(?:arxiv[.:/ ]+)([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (doiArxivMatch) return normalizeArxivId(doiArxivMatch[1]);

  const arxivIdMatch = text.match(ARXIV_ID_PATTERN);
  return arxivIdMatch ? normalizeArxivId(arxivIdMatch[0]) : '';
}

export function extractOpenReviewId(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const urlId = parseUrl(text, (url) => {
    if (!OPENREVIEW_URL_PATTERN.test(url.hostname)) return '';
    return url.searchParams.get('id')?.trim() || '';
  });
  if (urlId) return urlId;

  return extractPrefixedOpenReviewId(text);
}

export function normalizeCandidate(candidate = {}) {
  const normalized = {};

  for (const [field, rawValue] of Object.entries(candidate || {})) {
    if (field === 'canonical_url' || field === 'url') {
      normalized[field] = normalizeUrl(rawValue);
    } else if (LIST_FIELDS.has(field)) {
      normalized[field] = normalizeListValue(rawValue);
    } else {
      normalized[field] = stringifyValue(rawValue);
    }
  }

  if (!normalized.canonical_url && candidate?.url != null) {
    normalized.canonical_url = normalizeUrl(candidate.url);
  }

  for (const field of ['title', 'doi', 'arxiv_id', 'openreview_id', 'canonical_url', 'authors', 'institutions']) {
    normalized[field] = normalized[field] ?? '';
  }

  return normalized;
}

export async function searchMetadata(query, env, options = {}) {
  const queryType = classifyMetadataQuery(query);
  const cacheKey = metadataCacheKey(queryType);
  if (!queryType.value || queryType.type === 'unknown') {
    return { queryType, candidates: [], fromCache: false };
  }

  if (!options.bypassCache) {
    const cached = await getCachedMetadata(env, cacheKey);
    if (cached) {
      return { queryType, candidates: cached, fromCache: true };
    }
  }

  let candidates = [];
  if (queryType.type === 'arxiv') {
    candidates = await searchArxiv(queryType.value, options);
  } else if (queryType.type === 'openreview') {
    candidates = await searchOpenReview(queryType.value, options);
  } else if (queryType.type === 'doi') {
    candidates = await searchCrossref(queryType.value, 'doi', options);
  } else if (queryType.type === 'title') {
    const openAlexCandidates = await searchOpenAlex(queryType.value, options);
    const crossrefCandidates = await searchCrossref(queryType.value, 'title', options);
    candidates = dedupeCandidates([...openAlexCandidates, ...crossrefCandidates]);
  }

  candidates = dedupeCandidates(candidates);
  await putCachedMetadata(env, cacheKey, candidates);
  return { queryType, candidates, fromCache: false };
}

export async function searchArxiv(arxivId, options = {}) {
  const id = normalizeArxivId(arxivId);
  if (!id) return [];

  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const text = await fetchText(url, options);
  if (!text) return [];

  const entries = matchXmlBlocks(text, 'entry');
  return dedupeCandidates(entries.map((entry) => {
    const entryId = xmlText(entry, 'id');
    const detectedArxivId = extractArxivId(entryId) || id;
    const authors = matchXmlBlocks(entry, 'author').map((author) => xmlText(author, 'name')).filter(Boolean);
    const doi = xmlText(entry, 'arxiv:doi') || xmlText(entry, 'doi');

    return normalizeCandidate({
      title: xmlText(entry, 'title'),
      abstract: xmlText(entry, 'summary'),
      authors,
      doi,
      arxiv_id: detectedArxivId,
      canonical_url: detectedArxivId ? `https://arxiv.org/abs/${detectedArxivId}` : entryId,
      published_at: xmlText(entry, 'published'),
      year: yearFromDate(xmlText(entry, 'published')),
      metadata_source: 'arxiv'
    });
  }).filter((candidate) => candidate.title || candidate.arxiv_id));
}

export async function searchOpenReview(openreviewId, options = {}) {
  const id = String(openreviewId || '').trim();
  if (!id) return [];

  const urls = [
    `https://api2.openreview.net/notes?id=${encodeURIComponent(id)}`,
    `https://api2.openreview.net/notes?forum=${encodeURIComponent(id)}&limit=1`
  ];

  for (const url of urls) {
    const data = await fetchJson(url, options);
    const notes = Array.isArray(data?.notes) ? data.notes : [];
    if (!notes.length) continue;

    return dedupeCandidates(notes.map((note) => normalizeOpenReviewNote(note, id)));
  }

  return [];
}

export async function searchCrossref(value, mode = 'title', options = {}) {
  const query = String(value || '').trim();
  if (!query) return [];

  const url = mode === 'doi'
    ? `https://api.crossref.org/works/${encodeURIComponent(query)}`
    : `https://api.crossref.org/works?query.title=${encodeURIComponent(query)}&rows=5`;
  const data = await fetchJson(url, options);
  const items = mode === 'doi'
    ? [data?.message].filter(Boolean)
    : (Array.isArray(data?.message?.items) ? data.message.items : []);

  return dedupeCandidates(items.map(normalizeCrossrefWork).filter((candidate) => candidate.title || candidate.doi));
}

export async function searchOpenAlex(title, options = {}) {
  const query = String(title || '').trim();
  if (!query) return [];

  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5`;
  const data = await fetchJson(url, options);
  const works = Array.isArray(data?.results) ? data.results : [];
  return dedupeCandidates(works.map(normalizeOpenAlexWork).filter((candidate) => candidate.title || candidate.doi));
}

export function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const deduped = [];

  for (const rawCandidate of candidates) {
    const candidate = normalizeCandidate(rawCandidate);
    const keys = candidateIdentities(candidate);
    if (!keys.length || keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

export async function getCachedMetadata(env, cacheKey) {
  if (!env?.DB || !cacheKey) return null;

  try {
    const row = await env.DB.prepare('SELECT result_json FROM metadata_cache WHERE query = ?').bind(cacheKey).first();
    if (!row?.result_json) return null;

    const parsed = JSON.parse(row.result_json);
    const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
    return Array.isArray(candidates) ? dedupeCandidates(candidates) : null;
  } catch {
    return null;
  }
}

export async function putCachedMetadata(env, cacheKey, candidates) {
  if (!env?.DB || !cacheKey) return;

  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO metadata_cache (query, result_json, created_at) VALUES (?, ?, ?)'
    ).bind(cacheKey, JSON.stringify(candidates || []), new Date().toISOString()).run();
  } catch {
    // Metadata search should still succeed if cache writes are unavailable.
  }
}

export function decodeXml(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === '#') {
      const radix = body[1]?.toLowerCase() === 'x' ? 16 : 10;
      const number = Number.parseInt(radix === 16 ? body.slice(2) : body.slice(1), radix);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }

    const named = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"'
    };
    return named[body.toLowerCase()] ?? entity;
  });
}

export const xmlDecode = decodeXml;

export function stripHtml(value) {
  return decodeXml(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function invertedIndexToText(index) {
  if (!index || typeof index !== 'object') return '';

  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0) {
        words[position] = word;
      }
    }
  }

  return words.filter((word) => word != null).join(' ').trim();
}

export function detectDuplicate(candidate, existingCandidates = [], options = {}) {
  const titleThreshold = options.titleThreshold ?? DEFAULT_TITLE_THRESHOLD;
  const normalizedCandidate = normalizeCandidate(candidate);
  const normalizedExisting = existingCandidates.map((item) => normalizeCandidate(item));

  for (const field of ['doi', 'arxiv_id', 'openreview_id', 'canonical_url']) {
    const candidateValue = identifierKey(normalizedCandidate[field]);
    if (!candidateValue) continue;

    const match = normalizedExisting.find((item) => identifierKey(item[field]) === candidateValue);
    if (match) {
      return {
        status: 'definite',
        reason: field,
        paper: match
      };
    }
  }

  let bestMatch = null;
  let bestScore = 0;
  for (const item of normalizedExisting) {
    const score = similarityScore(normalizedCandidate.title, item.title);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestMatch && bestScore >= titleThreshold) {
    return {
      status: 'suspected',
      reason: 'title',
      paper: bestMatch,
      score: bestScore
    };
  }

  return {
    status: 'none',
    reason: '',
    paper: null
  };
}

function extractDoi(value) {
  const text = String(value || '').trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  const match = text.match(DOI_PATTERN);
  return match ? match[0].replace(/[.,;]+$/g, '') : '';
}

function isArxivUrl(value) {
  return Boolean(parseUrl(value, (url) => ARXIV_URL_PATTERN.test(url.hostname)));
}

function normalizeArxivId(value) {
  return String(value || '').trim().replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
}

function extractPrefixedOpenReviewId(value) {
  const match = String(value || '').trim().match(/^(?:openreview|forum):\s*([A-Za-z0-9_-]{3,64})$/i);
  return match ? match[1] : '';
}

function normalizeListValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stringifyValue(item)).filter(Boolean).join('; ');
  }
  return stringifyValue(value);
}

function metadataCacheKey(queryType) {
  return `${queryType.type}:${queryType.value}`.toLowerCase();
}

function normalizeOpenReviewNote(note, requestedId) {
  const content = note?.content || {};
  const title = openReviewContentValue(content.title);
  const abstract = openReviewContentValue(content.abstract);
  const authors = openReviewContentValue(content.authors);
  const authorIds = openReviewContentValue(content.authorids);
  const venue = openReviewContentValue(content.venue) || openReviewContentValue(content.venueid);
  const doi = openReviewContentValue(content.doi);
  const arxivId = openReviewContentValue(content.arxiv_id) || extractArxivId(openReviewContentValue(content.arxiv));
  const forumId = note?.forum || note?.id || requestedId;

  return normalizeCandidate({
    title,
    abstract,
    authors: authors || authorIds,
    doi,
    arxiv_id: arxivId,
    openreview_id: forumId,
    canonical_url: `https://openreview.net/forum?id=${encodeURIComponent(forumId)}`,
    venue,
    year: yearFromDate(note?.cdate ? new Date(note.cdate).toISOString() : ''),
    metadata_source: 'openreview'
  });
}

function normalizeCrossrefWork(work) {
  const doi = stringifyValue(work?.DOI);
  return normalizeCandidate({
    title: firstValue(work?.title),
    abstract: stripHtml(work?.abstract),
    authors: crossrefAuthors(work?.author),
    institutions: crossrefInstitutions(work?.author),
    doi,
    canonical_url: doi ? `https://doi.org/${doi}` : work?.URL,
    venue: firstValue(work?.['container-title']),
    published_at: crossrefDate(work),
    year: yearFromDate(crossrefDate(work)),
    metadata_source: 'crossref'
  });
}

function normalizeOpenAlexWork(work) {
  const doi = stringifyValue(work?.doi).replace(/^https?:\/\/doi\.org\//i, '');
  const locations = [
    work?.primary_location,
    work?.best_oa_location,
    ...(Array.isArray(work?.locations) ? work.locations : [])
  ].filter(Boolean);
  const locationUrls = locations.flatMap((location) => [
    location?.landing_page_url,
    location?.pdf_url
  ]).filter(Boolean);
  const arxivId = locationUrls.map(extractArxivId).find(Boolean);

  return normalizeCandidate({
    title: work?.display_name,
    abstract: invertedIndexToText(work?.abstract_inverted_index),
    authors: openAlexAuthors(work?.authorships),
    institutions: openAlexInstitutions(work?.authorships),
    doi,
    arxiv_id: arxivId,
    canonical_url: doi ? `https://doi.org/${doi}` : firstValue(locationUrls) || work?.id,
    venue: work?.primary_location?.source?.display_name || work?.host_venue?.display_name,
    published_at: work?.publication_date,
    year: stringifyValue(work?.publication_year) || yearFromDate(work?.publication_date),
    metadata_source: 'openalex'
  });
}

function openReviewContentValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(openReviewContentValue).filter(Boolean).join('; ');
  if (typeof value === 'object' && 'value' in value) return openReviewContentValue(value.value);
  return stringifyValue(value);
}

function crossrefAuthors(authors) {
  if (!Array.isArray(authors)) return '';
  return authors.map((author) => [author.given, author.family].map(stringifyValue).filter(Boolean).join(' ')).filter(Boolean).join('; ');
}

function crossrefInstitutions(authors) {
  if (!Array.isArray(authors)) return '';
  return authors.flatMap((author) => Array.isArray(author.affiliation) ? author.affiliation : [])
    .map((affiliation) => stringifyValue(affiliation.name))
    .filter(Boolean)
    .join('; ');
}

function openAlexAuthors(authorships) {
  if (!Array.isArray(authorships)) return '';
  return authorships.map((authorship) => stringifyValue(authorship?.author?.display_name)).filter(Boolean).join('; ');
}

function openAlexInstitutions(authorships) {
  if (!Array.isArray(authorships)) return '';
  return authorships.flatMap((authorship) => Array.isArray(authorship?.institutions) ? authorship.institutions : [])
    .map((institution) => stringifyValue(institution.display_name))
    .filter(Boolean)
    .join('; ');
}

function crossrefDate(work) {
  const dateParts = work?.published?.['date-parts'] || work?.['published-print']?.['date-parts'] || work?.['published-online']?.['date-parts'] || work?.issued?.['date-parts'];
  const parts = Array.isArray(dateParts?.[0]) ? dateParts[0] : [];
  return parts.length ? parts.map((part) => String(part).padStart(2, '0')).join('-') : '';
}

function yearFromDate(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function firstValue(value) {
  if (Array.isArray(value)) return stringifyValue(value[0]);
  return stringifyValue(value);
}

function candidateIdentities(candidate) {
  const keys = [];
  for (const field of ['doi', 'arxiv_id', 'openreview_id', 'canonical_url']) {
    const key = identifierKey(candidate[field]);
    if (key) keys.push(`${field}:${key}`);
  }

  const title = normalizeTitle(candidate.title);
  if (title) keys.push(`title:${title}`);
  return keys;
}

async function fetchJson(url, options) {
  try {
    const response = await fetchWithTimeout(url, options);
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchText(url, options) {
  try {
    const response = await fetchWithTimeout(url, options);
    if (!response?.ok) return '';
    return await response.text();
  } catch {
    return '';
  }
}

async function fetchWithTimeout(url, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    return await fetchImpl(url, {
      headers: {
        Accept: 'application/json, application/atom+xml, text/xml;q=0.9, */*;q=0.8'
      },
      signal: controller?.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function matchXmlBlocks(xml, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'gi');
  return Array.from(String(xml || '').matchAll(regex), (match) => match[1]);
}

function xmlText(xml, tag) {
  const block = matchXmlBlocks(xml, tag)[0] || '';
  return stripHtml(block);
}

function stringifyValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => stringifyValue(item)).filter(Boolean).join('; ');
  return String(value).trim();
}

function identifierKey(value) {
  return String(value || '').trim().toLowerCase();
}

function tokenSet(value) {
  return new Set(value.split(' ').map(stemToken).filter(Boolean));
}

function stemToken(value) {
  if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith('s')) return value.slice(0, -1);
  return value;
}

function bigrams(value) {
  const compact = value.replace(/\s+/g, ' ');
  if (compact.length < 2) return new Set([compact]);

  const pairs = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    pairs.add(compact.slice(index, index + 2));
  }
  return pairs;
}

function diceScore(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) overlap += 1;
  }
  return (2 * overlap) / (left.size + right.size);
}

function roundScore(value) {
  return Math.round(value * 10000) / 10000;
}

function parseUrl(value, reader) {
  try {
    return reader(new URL(value));
  } catch {
    return '';
  }
}
