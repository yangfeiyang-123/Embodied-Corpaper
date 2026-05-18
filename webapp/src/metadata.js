import { normalizeUrl } from './paper-utils.js';

const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s<>"{}|\\^`]+/i;
const ARXIV_ID_BODY = String.raw`(?:[a-z-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})`;
const ARXIV_ID_PATTERN = new RegExp(`^${ARXIV_ID_BODY}(?:v\\d+)?$`, 'i');
const ARXIV_URL_PATTERN = /(?:^|\.)arxiv\.org$/i;
const OPENREVIEW_URL_PATTERN = /(?:^|\.)openreview\.net$/i;
const LIST_FIELDS = new Set(['authors', 'institutions']);
const DEFAULT_TITLE_THRESHOLD = 0.82;
const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const METADATA_CACHE_VERSION = 'v4';
const DIRECT_IDENTIFIER_TYPES = new Set(['arxiv', 'doi', 'openreview']);
const SEMANTIC_SCHOLAR_FIELDS = [
  'paperId',
  'externalIds',
  'url',
  'title',
  'abstract',
  'authors',
  'venue',
  'year',
  'publicationDate',
  'citationCount'
].join(',');
const CITATION_SOURCE_PRIORITY = {
  semantic_scholar: 3,
  openalex: 2,
  crossref: 1
};
const PUBLICATION_SOURCE_PRIORITY = {
  crossref: 4,
  semantic_scholar: 3,
  openalex: 2,
  openreview: 1,
  arxiv: 0
};

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
  const text = cleanIdentifierInput(value);
  if (!text) return '';

  const arxivUrlId = parseUrl(text, (url) => {
    if (!ARXIV_URL_PATTERN.test(url.hostname)) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    if (parts[0] && !['abs', 'pdf', 'html'].includes(parts[0].toLowerCase())) return '';
    const rawId = parts[parts.length - 1].replace(/\.pdf$/i, '');
    return normalizeArxivId(rawId);
  });
  if (arxivUrlId) return arxivUrlId;

  const doiArxivMatch = text.match(new RegExp(`(?:arxiv(?:\\s*id)?[.:/\\s]+)(${ARXIV_ID_BODY})(?:v\\d+)?`, 'i'));
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
    } else if (field === 'citation_count') {
      normalized[field] = normalizeCitationCount(rawValue);
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
    if (cached && shouldUseCachedMetadata(queryType, cached)) {
      const enriched = await enrichCitationCounts(cached, options);
      await putCachedMetadata(env, cacheKey, enriched);
      return { queryType, candidates: enriched, fromCache: true };
    }
  }

  let candidates = [];
  if (queryType.type === 'arxiv') {
    const arxivCandidates = await searchArxiv(queryType.value, options);
    const semanticCandidates = await searchSemanticScholar(queryType.value, 'arxiv', options);
    candidates = mergeCandidates([...arxivCandidates, ...semanticCandidates]);
  } else if (queryType.type === 'openreview') {
    candidates = await searchOpenReview(queryType.value, options);
  } else if (queryType.type === 'doi') {
    const crossrefCandidates = await searchCrossref(queryType.value, 'doi', options);
    const semanticCandidates = await searchSemanticScholar(queryType.value, 'doi', options);
    candidates = mergeCandidates([...crossrefCandidates, ...semanticCandidates]);
  } else if (queryType.type === 'title') {
    const arxivCandidates = await searchArxivByTitle(queryType.value, options);
    const semanticCandidates = await searchSemanticScholar(queryType.value, 'title', options);
    const openAlexCandidates = await searchOpenAlex(queryType.value, options);
    const crossrefCandidates = await searchCrossref(queryType.value, 'title', options);
    candidates = mergeCandidates([...arxivCandidates, ...semanticCandidates, ...openAlexCandidates, ...crossrefCandidates]);
  }

  candidates = await enrichCitationCounts(mergeCandidates(candidates), options);
  if (shouldCacheMetadataResult(queryType, candidates)) {
    await putCachedMetadata(env, cacheKey, candidates);
  }
  return { queryType, candidates, fromCache: false };
}

export async function searchArxiv(arxivId, options = {}) {
  const id = normalizeArxivId(arxivId);
  if (!id) return [];

  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const text = await fetchText(url, options);
  if (!text) return searchArxivAbsPage(id, options);

  const candidates = normalizeArxivFeed(text);
  return candidates.length ? candidates : searchArxivAbsPage(id, options);
}

export async function searchArxivByTitle(title, options = {}) {
  const query = String(title || '').trim();
  if (!query) return [];

  const safeTitle = query.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safeTitle) return [];

  const searches = [
    `ti:"${safeTitle}"`,
    `all:"${safeTitle}"`
  ];

  for (const search of searches) {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(search)}&start=0&max_results=5&sortBy=relevance&sortOrder=descending`;
    const text = await fetchText(url, options);
    const candidates = normalizeArxivFeed(text)
      .filter((candidate) => similarityScore(query, candidate.title) >= 0.72);
    if (candidates.length) return candidates;
  }

  return [];
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

export async function searchSemanticScholar(value, mode = 'title', options = {}) {
  const query = String(value || '').trim();
  if (!query) return [];

  const directPrefix = mode === 'doi' ? 'DOI' : mode === 'arxiv' ? 'ARXIV' : '';
  if (directPrefix) {
    const identifier = mode === 'arxiv' ? normalizeArxivId(query) : query;
    const directUrl = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(`${directPrefix}:${identifier}`)}?fields=${encodeURIComponent(SEMANTIC_SCHOLAR_FIELDS)}`;
    const directData = await fetchJson(directUrl, options);
    const directCandidate = normalizeSemanticScholarPaper(directData);
    if (directCandidate.title || directCandidate.doi || directCandidate.arxiv_id) {
      return [directCandidate];
    }
  }

  const searchUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=${encodeURIComponent(SEMANTIC_SCHOLAR_FIELDS)}`;
  const data = await fetchJson(searchUrl, options);
  const papers = Array.isArray(data?.data) ? data.data : [];
  return dedupeCandidates(papers.map(normalizeSemanticScholarPaper).filter((candidate) => candidate.title || candidate.doi || candidate.arxiv_id));
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

export function mergeCandidates(candidates = []) {
  const merged = [];

  for (const rawCandidate of candidates) {
    const candidate = normalizeCandidate(rawCandidate);
    if (!candidate.title && !candidate.doi && !candidate.arxiv_id && !candidate.canonical_url) continue;

    const index = merged.findIndex((existing) => isSamePaper(existing, candidate));
    if (index >= 0) {
      merged[index] = mergeCandidate(merged[index], candidate);
    } else {
      merged.push(candidate);
    }
  }

  return merged;
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
  const text = cleanIdentifierInput(value).replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  const match = text.match(DOI_PATTERN);
  return match ? match[0].replace(/[.,;]+$/g, '') : '';
}

function isArxivUrl(value) {
  return Boolean(parseUrl(cleanIdentifierInput(value), (url) => ARXIV_URL_PATTERN.test(url.hostname)));
}

function normalizeArxivId(value) {
  return String(value || '').trim().replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
}

function cleanIdentifierInput(value) {
  return String(value || '')
    .trim()
    .replace(/^[<（(【[]+/, '')
    .replace(/[>）)】\]]+$/, '')
    .replace(/[，。；、,.;]+$/, '')
    .trim();
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
  return `${METADATA_CACHE_VERSION}:${queryType.type}:${queryType.value}`.toLowerCase();
}

function shouldUseCachedMetadata(queryType, cached) {
  if (!DIRECT_IDENTIFIER_TYPES.has(queryType.type)) return true;
  return Array.isArray(cached) && cached.length > 0;
}

function shouldCacheMetadataResult(queryType, candidates) {
  if (!DIRECT_IDENTIFIER_TYPES.has(queryType.type)) return true;
  return Array.isArray(candidates) && candidates.length > 0;
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
    publication_source: 'openreview',
    metadata_source: 'openreview'
  });
}

function normalizeArxivFeed(xml) {
  const entries = matchXmlBlocks(xml, 'entry');
  return dedupeCandidates(entries.map(normalizeArxivEntry).filter((candidate) => candidate.title || candidate.arxiv_id));
}

function normalizeArxivEntry(entry) {
  const entryId = xmlText(entry, 'id');
  const detectedArxivId = extractArxivId(entryId);
  const authors = matchXmlBlocks(entry, 'author').map((author) => xmlText(author, 'name')).filter(Boolean);
  const doi = xmlText(entry, 'arxiv:doi') || xmlText(entry, 'doi');
  const publishedAt = arxivDate(xmlText(entry, 'published'));

  return normalizeCandidate({
    title: xmlText(entry, 'title'),
    abstract: xmlText(entry, 'summary'),
    authors,
    doi,
    arxiv_id: detectedArxivId,
    canonical_url: detectedArxivId ? `https://arxiv.org/abs/${detectedArxivId}` : entryId,
    published_at: publishedAt,
    publication_source: 'arxiv',
    year: yearFromDate(publishedAt),
    metadata_source: 'arxiv'
  });
}

async function searchArxivAbsPage(arxivId, options = {}) {
  const id = normalizeArxivId(arxivId);
  if (!id) return [];

  const html = await fetchText(`https://arxiv.org/abs/${encodeURIComponent(id)}`, options);
  if (!html) return [];

  const candidate = normalizeArxivAbsHtml(html, id);
  return candidate.title || candidate.arxiv_id ? [candidate] : [];
}

function normalizeArxivAbsHtml(html, requestedId = '') {
  const arxivId = htmlMetaContent(html, 'name', 'citation_arxiv_id')
    || extractArxivId(htmlMetaContent(html, 'property', 'og:url'))
    || normalizeArxivId(requestedId);
  const rawDate = htmlMetaContent(html, 'name', 'citation_date')
    || htmlMetaContent(html, 'name', 'citation_online_date')
    || arxivSubmittedDate(html);
  const publishedAt = normalizeMetadataDate(rawDate);
  const authors = htmlMetaContents(html, 'name', 'citation_author');

  return normalizeCandidate({
    title: htmlMetaContent(html, 'name', 'citation_title') || htmlMetaContent(html, 'property', 'og:title'),
    abstract: htmlMetaContent(html, 'name', 'citation_abstract') || htmlMetaContent(html, 'property', 'og:description'),
    authors,
    arxiv_id: arxivId,
    canonical_url: arxivId ? `https://arxiv.org/abs/${arxivId}` : '',
    published_at: publishedAt,
    publication_source: 'arxiv',
    year: yearFromDate(publishedAt),
    metadata_source: 'arxiv'
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
    publication_source: 'crossref',
    year: yearFromDate(crossrefDate(work)),
    citation_count: work?.['is-referenced-by-count'],
    citation_source: 'crossref',
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
    publication_source: 'openalex',
    year: stringifyValue(work?.publication_year) || yearFromDate(work?.publication_date),
    citation_count: work?.cited_by_count,
    citation_source: 'openalex',
    metadata_source: 'openalex'
  });
}

function normalizeSemanticScholarPaper(paper) {
  if (!paper || typeof paper !== 'object') return normalizeCandidate({});

  const externalIds = paper.externalIds || {};
  const doi = externalIds.DOI || externalIds.DOIArXiv || '';
  const arxivId = externalIds.ArXiv || externalIds.ARCHIVE || '';

  return normalizeCandidate({
    title: paper.title,
    abstract: paper.abstract,
    authors: Array.isArray(paper.authors) ? paper.authors.map((author) => author?.name).filter(Boolean) : '',
    doi,
    arxiv_id: arxivId,
    canonical_url: paper.url,
    venue: paper.venue,
    published_at: paper.publicationDate,
    publication_source: 'semantic_scholar',
    year: paper.year,
    citation_count: paper.citationCount,
    citation_source: 'semantic_scholar',
    metadata_source: 'semantic_scholar'
  });
}

async function enrichCitationCounts(candidates, options = {}) {
  const enriched = [];

  for (const candidate of candidates) {
    let merged = candidate;

    if (shouldEnrichWithSemanticScholar(merged)) {
      const semantic = await searchSemanticScholarCitation(merged, options);
      if (semantic) merged = mergeCandidate(merged, semantic);
    }

    if (shouldEnrichWithOpenAlex(merged)) {
      const openAlex = await searchOpenAlexCitation(merged, options);
      if (openAlex) merged = mergeCandidate(merged, openAlex);
    }

    if (shouldEnrichWithCrossref(merged)) {
      const crossref = await searchCrossrefCitation(merged, options);
      if (crossref) merged = mergeCandidate(merged, crossref);
    }

    enriched.push(merged);
  }

  return mergeCandidates(enriched);
}

async function searchSemanticScholarCitation(candidate, options = {}) {
  const queries = citationQueries(candidate);

  for (const query of queries) {
    const candidates = await searchSemanticScholar(query.value, query.mode, options);
    const match = candidates.find((work) => isCitationMatch(candidate, work));
    if (match) return match;
  }

  return null;
}

async function searchOpenAlexCitation(candidate, options = {}) {
  const queries = citationQueries(candidate);

  for (const query of queries) {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query.value)}&per-page=5`;
    const data = await fetchJson(url, options);
    const works = Array.isArray(data?.results) ? data.results : [];
    if (!works.length) continue;

    const normalized = works.map(normalizeOpenAlexWork);
    const match = normalized.find((work) => isCitationMatch(candidate, work));
    if (match) return match;
  }

  return null;
}

async function searchCrossrefCitation(candidate, options = {}) {
  const queries = citationQueries(candidate).filter((query) => query.mode === 'doi' || query.mode === 'title');

  for (const query of queries) {
    const candidates = await searchCrossref(query.value, query.mode, options);
    const match = candidates.find((work) => isCitationMatch(candidate, work));
    if (match) return match;
  }

  return null;
}

function shouldEnrichWithSemanticScholar(candidate) {
  return citationSourcePriority(candidate.citation_source) < CITATION_SOURCE_PRIORITY.semantic_scholar
    || publicationSourcePriority(candidate.publication_source || candidate.metadata_source) < PUBLICATION_SOURCE_PRIORITY.semantic_scholar;
}

function shouldEnrichWithOpenAlex(candidate) {
  return !hasCitationCount(candidate)
    || citationSourcePriority(candidate.citation_source) < CITATION_SOURCE_PRIORITY.openalex
    || publicationSourcePriority(candidate.publication_source || candidate.metadata_source) < PUBLICATION_SOURCE_PRIORITY.openalex;
}

function shouldEnrichWithCrossref(candidate) {
  return !hasPositiveCitationCount(candidate)
    || citationSourcePriority(candidate.citation_source) < CITATION_SOURCE_PRIORITY.crossref
    || publicationSourcePriority(candidate.publication_source || candidate.metadata_source) < PUBLICATION_SOURCE_PRIORITY.crossref;
}

function citationQueries(candidate) {
  const queries = [
    { value: candidate.doi, mode: 'doi' },
    { value: candidate.arxiv_id, mode: 'arxiv' },
    { value: candidate.title, mode: 'title' }
  ];
  const seen = new Set();
  return queries.filter((query) => {
    const value = String(query.value || '').trim();
    if (!value) return false;
    const key = `${query.mode}:${value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    query.value = value;
    return true;
  });
}

function isCitationMatch(candidate, work) {
  const candidateDoi = identifierKey(candidate.doi);
  const workDoi = identifierKey(work.doi);
  if (candidateDoi && workDoi && candidateDoi === workDoi) return true;

  const candidateArxivId = identifierKey(candidate.arxiv_id);
  const workArxivId = identifierKey(work.arxiv_id);
  if (candidateArxivId && workArxivId && candidateArxivId === workArxivId) return true;

  return similarityScore(candidate.title, work.title) >= 0.9;
}

function isSamePaper(left, right) {
  for (const field of ['doi', 'arxiv_id', 'openreview_id', 'canonical_url']) {
    const leftValue = identifierKey(left[field]);
    const rightValue = identifierKey(right[field]);
    if (leftValue && rightValue && leftValue === rightValue) return true;
  }

  return similarityScore(left.title, right.title) >= 0.92;
}

function mergeCandidate(left, right) {
  const merged = { ...left };
  const preserveArxivPublicationDate = left.publication_source === 'arxiv' && left.published_at;

  for (const [field, value] of Object.entries(right)) {
    if (!value && value !== 0) continue;
    if (!merged[field]) merged[field] = value;
  }

  if (right.abstract && (!left.abstract || right.abstract.length > left.abstract.length)) {
    merged.abstract = right.abstract;
  }
  if (right.authors && (!left.authors || right.authors.length > left.authors.length)) {
    merged.authors = right.authors;
  }
  if (right.institutions && (!left.institutions || right.institutions.length > left.institutions.length)) {
    merged.institutions = right.institutions;
  }
  if (!preserveArxivPublicationDate && preferredPublicationDate(right, left) === right.published_at) {
    merged.published_at = right.published_at;
    merged.publication_source = right.publication_source || right.metadata_source || merged.publication_source || '';
    merged.year = right.year || yearFromDate(right.published_at) || merged.year || '';
  }
  if (preferredCitationCandidate(right, left) === right) {
    merged.citation_count = right.citation_count;
    merged.citation_source = right.citation_source || merged.citation_source || '';
  }
  if (right.doi && !merged.doi) merged.doi = right.doi;
  if (right.arxiv_id && !merged.arxiv_id) merged.arxiv_id = right.arxiv_id;
  if (right.openreview_id && !merged.openreview_id) merged.openreview_id = right.openreview_id;

  return normalizeCandidate(merged);
}

function preferredPublicationDate(left, right) {
  if (!left?.published_at) return right?.published_at || '';
  if (!right?.published_at) return left.published_at;

  const leftPriority = publicationSourcePriority(left.publication_source || left.metadata_source);
  const rightPriority = publicationSourcePriority(right.publication_source || right.metadata_source);
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority ? left.published_at : right.published_at;
  }

  return String(left.published_at).length >= String(right.published_at).length ? left.published_at : right.published_at;
}

function preferredCitationCandidate(left, right) {
  const leftHasCitation = hasCitationCount(left);
  const rightHasCitation = hasCitationCount(right);
  if (!leftHasCitation) return right;
  if (!rightHasCitation) return left;

  const leftCount = Number.parseInt(left.citation_count, 10);
  const rightCount = Number.parseInt(right.citation_count, 10);
  if (leftCount > 0 && rightCount <= 0) return left;
  if (rightCount > 0 && leftCount <= 0) return right;

  const leftPriority = citationSourcePriority(left.citation_source);
  const rightPriority = citationSourcePriority(right.citation_source);
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority ? left : right;
  }

  return leftCount >= rightCount ? left : right;
}

function citationSourcePriority(source) {
  return CITATION_SOURCE_PRIORITY[String(source || '').toLowerCase()] || 0;
}

function publicationSourcePriority(source) {
  return PUBLICATION_SOURCE_PRIORITY[String(source || '').toLowerCase()] ?? -1;
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

function arxivDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (byType.year && byType.month && byType.day) {
      return `${byType.year}-${byType.month}-${byType.day}`;
    }
  } catch {
    // Fall back to the UTC date if timezone formatting is unavailable.
  }

  return text.slice(0, 10);
}

function yearFromDate(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function firstValue(value) {
  if (Array.isArray(value)) return stringifyValue(value[0]);
  return stringifyValue(value);
}

function normalizeCitationCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count >= 0 ? count : '';
}

function hasCitationCount(candidate) {
  return Number.isFinite(Number.parseInt(candidate?.citation_count, 10));
}

function hasPositiveCitationCount(candidate) {
  const count = Number.parseInt(candidate?.citation_count, 10);
  return Number.isFinite(count) && count > 0;
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

function htmlMetaContent(html, key, value) {
  return htmlMetaContents(html, key, value)[0] || '';
}

function htmlMetaContents(html, key, value) {
  return htmlTags(html, 'meta')
    .map(parseHtmlAttributes)
    .filter((attrs) => String(attrs[key] || '').toLowerCase() === String(value || '').toLowerCase())
    .map((attrs) => stripHtml(attrs.content || ''))
    .filter(Boolean);
}

function htmlTags(html, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>`, 'gi');
  return Array.from(String(html || '').matchAll(regex), (match) => match[0]);
}

function parseHtmlAttributes(tag) {
  const attrs = {};
  const regex = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of String(tag || '').matchAll(regex)) {
    attrs[match[1].toLowerCase()] = decodeXml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function normalizeMetadataDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const slashMatch = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[3].padStart(2, '0')}`;
  }
  const dashMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dashMatch) {
    return `${dashMatch[1]}-${dashMatch[2].padStart(2, '0')}-${dashMatch[3].padStart(2, '0')}`;
  }
  return arxivDate(text);
}

function arxivSubmittedDate(html) {
  const text = stripHtml(String(html || '').match(/<div[^>]*class=["'][^"']*\bdateline\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
  const match = text.match(/Submitted on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!match) return '';
  const month = monthNumber(match[2]);
  return month ? `${match[3]}-${month}-${match[1].padStart(2, '0')}` : '';
}

function monthNumber(name) {
  const months = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12'
  };
  return months[String(name || '').slice(0, 3).toLowerCase()] || '';
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
