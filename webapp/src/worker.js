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
import { createComment, deleteComment, listComments } from './comments.js';
import { detectDuplicate, extractArxivId, searchArxiv, searchArxivByTitle, searchMetadata } from './metadata.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Password, X-User-Name'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname.startsWith('/api/')) {
      return withCors(await handleApi(request, env, url));
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleApi(request, env, url) {
  if (!env.DB) {
    return json({ error: 'D1 database binding DB is not configured' }, 500);
  }

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    if (request.method === 'POST' && url.pathname === '/api/metadata/search') {
      return searchMetadataEndpoint(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/metadata/backfill') {
      return backfillMetadataEndpoint(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      return registerUser(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      return loginUser(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/papers') {
      return listPapers(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/todos') {
      return listTodos(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/todos') {
      return createTodo(request, env);
    }

    const todoPublishMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/publish$/);
    const publishTodoId = todoPublishMatch ? decodePathSegment(todoPublishMatch[1]) : null;
    if (todoPublishMatch && request.method === 'POST') {
      return publishTodo(request, env, publishTodoId);
    }

    const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
    const todoId = todoMatch ? decodePathSegment(todoMatch[1]) : null;
    if (todoMatch && request.method === 'PUT') {
      return updateTodo(request, env, todoId);
    }
    if (todoMatch && request.method === 'DELETE') {
      return deleteTodo(request, env, todoId);
    }

    if (request.method === 'POST' && url.pathname === '/api/papers') {
      return createPaper(request, env);
    }

    const paperMatch = url.pathname.match(/^\/api\/papers\/([^/]+)$/);
    const paperId = paperMatch ? decodePathSegment(paperMatch[1]) : null;

    const favMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/favorite$/);
    const favPaperId = favMatch ? decodePathSegment(favMatch[1]) : null;
    if (favMatch && request.method === 'POST') {
      return toggleFavorite(request, env, favPaperId);
    }

    const commentsMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/comments$/);
    const commentsPaperId = commentsMatch ? decodePathSegment(commentsMatch[1]) : null;
    if (commentsMatch && request.method === 'GET') {
      return listComments(env, commentsPaperId);
    }
    if (commentsMatch && request.method === 'POST') {
      return createComment(request, env, commentsPaperId);
    }

    const commentMatch = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
    const commentId = commentMatch ? decodePathSegment(commentMatch[1]) : null;
    if (commentMatch && request.method === 'DELETE') {
      return deleteComment(env, commentId);
    }

    if (paperMatch && request.method === 'PUT') {
      return updatePaper(request, env, paperId);
    }

    if (paperMatch && request.method === 'DELETE') {
      return deletePaper(env, paperId);
    }

    if (request.method === 'POST' && url.pathname === '/api/import') {
      return importPapers(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/export') {
      return exportPapers(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      return getStats(env);
    }

    return json({ error: 'Not found' }, 404);
  } catch (error) {
    return json({ error: error.message || 'Internal error' }, 500);
  }
}

function isAuthorized(request, env) {
  if (!env.APP_PASSWORD) return true;
  return request.headers.get('X-App-Password') === env.APP_PASSWORD;
}

async function listPapers(request, env) {
  const result = await env.DB.prepare('SELECT * FROM papers ORDER BY updated_at DESC').all();
  const papers = normalizeRows(result.results);
  const username = request.headers.get('X-User-Name') || '';
  if (username && papers.length) {
    const paperIds = papers.map((p) => p.id);
    const placeholders = paperIds.map(() => '?').join(', ');
    const favRows = await env.DB.prepare(
      `SELECT paper_id FROM favorites WHERE user_id = ? AND paper_id IN (${placeholders})`
    ).bind(username, ...paperIds).all();
    const favSet = new Set((favRows.results || []).map((r) => r.paper_id));
    for (const p of papers) {
      p.favorite = favSet.has(p.id) ? '是' : '否';
    }
  } else {
    for (const p of papers) {
      p.favorite = '否';
    }
  }
  return json({ papers });
}

async function searchMetadataEndpoint(request, env) {
  const data = await readJson(request);
  const query = String(data.query || '').trim();
  if (!query) {
    return json({ error: 'Query is required' }, 400);
  }

  const result = await searchMetadata(query, env, {
    bypassCache: data.bypassCache === true
  });
  const existing = await env.DB.prepare(
    'SELECT id, title, doi, arxiv_id, openreview_id, canonical_url FROM papers'
  ).all();
  const existingPapers = existing.results || [];
  const candidates = result.candidates.map((candidate) => ({
    ...candidate,
    duplicate: detectDuplicate(candidate, existingPapers)
  }));

  return json({
    ...result,
    candidates
  });
}

async function backfillMetadataEndpoint(request, env) {
  const data = await readJson(request);
  const overwrite = data.overwrite === true;
  const bypassCache = data.bypassCache === true;
  const limit = clampInteger(data.limit, 1, 200, 100);
  const actor = normalizeActor(request.headers.get('X-User-Name') || data.updated_by || 'metadata-backfill');
  const result = await env.DB.prepare('SELECT * FROM papers ORDER BY updated_at DESC').all();
  const papers = normalizeRows(result.results || []);
  const details = [];
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let noQuery = 0;
  let noCandidate = 0;
  let failed = 0;

  for (const paper of papers) {
    if (scanned >= limit) break;
    if (!needsMetadataBackfill(paper, overwrite)) {
      skipped += 1;
      continue;
    }

    scanned += 1;
    const query = metadataBackfillQuery(paper);
    if (!query) {
      noQuery += 1;
      details.push({ id: paper.id, title: paper.title, status: 'no_query' });
      continue;
    }

    try {
      let patch = {};
      let candidate = null;
      let arxivCandidate = null;
      const arxivId = paperArxivId(paper);
      if (arxivId) {
        arxivCandidate = await searchArxiv(arxivId, { timeoutMs: 12000 });
        arxivCandidate = arxivCandidate[0] || null;
      } else if (paper.title) {
        arxivCandidate = await searchArxivByTitle(paper.title, { timeoutMs: 12000 });
        arxivCandidate = selectBackfillCandidate(paper, arxivCandidate) || null;
      }
      if (arxivCandidate?.published_at) {
        patch = {
          ...patch,
          ...metadataBackfillPatch(paper, arxivCandidate, overwrite, { forceArxiv: true, forcePublishedAt: true })
        };
      }

      const metadata = await searchMetadata(query, env, { bypassCache });
      candidate = selectBackfillCandidate(paper, metadata.candidates || []);
      if (candidate) {
        patch = {
          ...patch,
          ...metadataBackfillPatch({ ...paper, ...patch }, candidate, overwrite)
        };
      }

      if (!candidate && !Object.keys(patch).length) {
        noCandidate += 1;
        details.push({ id: paper.id, title: paper.title, status: 'no_candidate', query });
        continue;
      }

      if (!Object.keys(patch).length) {
        skipped += 1;
        details.push({ id: paper.id, title: paper.title, status: 'unchanged', query });
        continue;
      }

      await applyMetadataBackfill(env, paper, patch, actor);
      updated += 1;
      details.push({
        id: paper.id,
        title: paper.title || candidate?.title || arxivCandidate?.title,
        status: 'updated',
        query,
        fields: Object.keys(patch)
      });
    } catch (error) {
      failed += 1;
      details.push({
        id: paper.id,
        title: paper.title,
        status: 'failed',
        query,
        error: error.message || 'unknown error'
      });
    }
  }

  return json({
    scanned,
    updated,
    skipped,
    noQuery,
    noCandidate,
    failed,
    limit,
    overwrite,
    details: details.slice(0, 50)
  });
}

async function createPaper(request, env) {
  const data = await readJson(request);
  const now = new Date().toISOString();
  const actor = normalizeActor(data.updated_by || data.created_by);
  const paper = normalizePaper({
    ...data,
    id: data.id || crypto.randomUUID(),
    created_by: data.created_by || actor,
    updated_by: actor,
    created_at: data.created_at || now,
    updated_at: now
  });

  await insertPaper(env, paper);
  const row = await env.DB.prepare('SELECT * FROM papers WHERE id = ?').bind(paper.id).first();
  return json(normalizeRow(row), 201);
}

async function listTodos(request, env) {
  const username = request.headers.get('X-User-Name') || '';
  if (!username) {
    return json({ error: 'Login required' }, 401);
  }

  const result = await env.DB.prepare(
    'SELECT * FROM todo_papers WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(username).all();
  return json({ todos: (result.results || []).map(normalizeTodoRow).filter(Boolean) });
}

async function createTodo(request, env) {
  const username = request.headers.get('X-User-Name') || '';
  if (!username) {
    return json({ error: 'Login required' }, 401);
  }
  const data = await readJson(request);
  const now = new Date().toISOString();
  const actor = normalizeActor(data.updated_by || data.created_by || username);
  const todo = normalizePaper({
    ...data,
    id: data.id || crypto.randomUUID(),
    favorite: '否',
    created_by: data.created_by || actor,
    updated_by: actor,
    created_at: data.created_at || now,
    updated_at: now
  });

  await env.DB.prepare(
    'INSERT INTO todo_papers (user_id, id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, todo.id, JSON.stringify(todo), todo.created_at, todo.updated_at).run();
  return json(normalizeRow(todo), 201);
}

async function updateTodo(request, env, id) {
  const username = request.headers.get('X-User-Name') || '';
  if (!username) {
    return json({ error: 'Login required' }, 401);
  }
  const current = await env.DB.prepare(
    'SELECT * FROM todo_papers WHERE user_id = ? AND id = ?'
  ).bind(username, id).first();
  if (!current) {
    return json({ error: 'Not found' }, 404);
  }

  const existing = normalizeTodoRow(current) || {};
  const data = await readJson(request);
  const now = new Date().toISOString();
  const actor = normalizeActor(data.updated_by || username);
  const todo = normalizePaper({
    ...existing,
    ...data,
    id,
    favorite: '否',
    created_by: data.created_by || existing.created_by || actor,
    updated_by: actor,
    created_at: data.created_at || existing.created_at || current.created_at || now,
    updated_at: now
  });

  await env.DB.prepare(
    'UPDATE todo_papers SET payload = ?, updated_at = ? WHERE user_id = ? AND id = ?'
  ).bind(JSON.stringify(todo), todo.updated_at, username, id).run();
  return json(normalizeRow(todo));
}

async function deleteTodo(request, env, id) {
  const username = request.headers.get('X-User-Name') || '';
  if (!username) {
    return json({ error: 'Login required' }, 401);
  }
  await env.DB.prepare('DELETE FROM todo_papers WHERE user_id = ? AND id = ?').bind(username, id).run();
  return json({ success: true });
}

async function publishTodo(request, env, id) {
  const username = request.headers.get('X-User-Name') || '';
  if (!username) {
    return json({ error: 'Login required' }, 401);
  }
  const row = await env.DB.prepare(
    'SELECT * FROM todo_papers WHERE user_id = ? AND id = ?'
  ).bind(username, id).first();
  if (!row) {
    return json({ error: 'Not found' }, 404);
  }

  const existingPaper = await env.DB.prepare('SELECT id FROM papers WHERE id = ?').bind(id).first();
  if (existingPaper) {
    return json({
      error: 'Conflict',
      message: '文献库中已存在同 ID 的文献，请先另存为新的待办。'
    }, 409);
  }

  const data = await readJson(request);
  const draft = normalizeTodoRow(row) || {};
  const now = new Date().toISOString();
  const actor = normalizeActor(data.updated_by || username);
  const paper = normalizePaper({
    ...draft,
    ...data,
    id,
    favorite: '否',
    created_by: actor,
    updated_by: actor,
    created_at: now,
    updated_at: now
  });

  await env.DB.batch([
    insertPaperStatement(env, paper),
    env.DB.prepare('DELETE FROM todo_papers WHERE user_id = ? AND id = ?').bind(username, id)
  ]);
  const saved = await env.DB.prepare('SELECT * FROM papers WHERE id = ?').bind(id).first();
  return json(normalizeRow(saved), 201);
}

function needsMetadataBackfill(paper, overwrite) {
  if (overwrite) return true;
  return !String(paper.published_at || '').trim()
    || !(Number.parseInt(paper.citation_count, 10) > 0)
    || !String(paper.doi || paper.arxiv_id || paper.openreview_id || paper.canonical_url || '').trim()
    || Boolean(!paper.arxiv_id && paperArxivId(paper))
    || looksLikeArxivRecord(paper);
}

function metadataBackfillQuery(paper) {
  return [
    paper.doi,
    paperArxivId(paper),
    paper.openreview_id ? `openreview:${paper.openreview_id}` : '',
    paper.canonical_url,
    paper.link,
    paper.title
  ].map((value) => String(value || '').trim()).find(Boolean) || '';
}

function selectBackfillCandidate(paper, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const comparablePaper = comparableBackfillPaper(paper);
  let bestCandidate = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const duplicate = detectDuplicate(candidate, [comparablePaper], { titleThreshold: 0.72 });
    const score = duplicate.status === 'definite'
      ? 2
      : duplicate.status === 'suspected'
        ? duplicate.score || 0.72
        : 0;
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate) return bestCandidate;
  if (candidates.length === 1 && !paper.title) return candidates[0];
  return null;
}

function paperArxivId(paper) {
  return paper.arxiv_id
    || extractArxivId(paper.doi)
    || extractArxivId(paper.canonical_url)
    || extractArxivId(paper.link)
    || '';
}

function looksLikeArxivRecord(paper) {
  const text = [
    paper.source,
    paper.link,
    paper.canonical_url,
    paper.metadata_source,
    paper.arxiv_id,
    paper.doi
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return text.includes('arxiv');
}

function comparableBackfillPaper(paper) {
  const arxivId = paperArxivId(paper);
  return {
    ...paper,
    arxiv_id: arxivId || paper.arxiv_id || '',
    canonical_url: paper.canonical_url || (arxivId ? `https://arxiv.org/abs/${arxivId}` : paper.link || '')
  };
}

function metadataBackfillPatch(paper, candidate, overwrite, options = {}) {
  const patch = {};
  const candidateDate = String(candidate.published_at || '').slice(0, 10);
  const citationCount = Number.parseInt(candidate.citation_count, 10);
  const candidateCitationSource = String(candidate.citation_source || '').trim();

  if (candidateDate && shouldPatchText(paper.published_at, candidateDate, overwrite || options.forcePublishedAt || paper.published_at === paper.readDate)) {
    patch.published_at = candidateDate;
  }
  if (Number.isFinite(citationCount) && citationCount >= 0 && candidateCitationSource && shouldPatchCitation(paper, citationCount, overwrite)) {
    patch.citation_count = citationCount;
    patch.citation_source = candidateCitationSource;
  }
  const forceArxiv = options.forceArxiv === true && candidate.metadata_source === 'arxiv';
  if (candidate.abstract && shouldPatchText(paper.abstract, candidate.abstract, forceArxiv && !paper.abstract)) patch.abstract = candidate.abstract;
  if (candidate.doi && shouldPatchText(paper.doi, candidate.doi, false)) patch.doi = candidate.doi;
  if (candidate.arxiv_id && shouldPatchText(paper.arxiv_id, candidate.arxiv_id, forceArxiv)) patch.arxiv_id = candidate.arxiv_id;
  if (candidate.openreview_id && shouldPatchText(paper.openreview_id, candidate.openreview_id, false)) patch.openreview_id = candidate.openreview_id;
  if (candidate.canonical_url && shouldPatchText(paper.canonical_url, candidate.canonical_url, forceArxiv)) patch.canonical_url = candidate.canonical_url;
  if (candidate.canonical_url && shouldPatchText(paper.link, candidate.canonical_url, false)) patch.link = candidate.canonical_url;
  if (candidate.authors && shouldPatchText(paper.authors, candidate.authors, forceArxiv && !paper.authors)) patch.authors = [candidate.authors, candidate.institutions].filter(Boolean).join('\n');
  if (candidate.metadata_source) patch.metadata_source = candidate.metadata_source;
  patch.metadata_checked_at = new Date().toISOString();

  if (candidate.year || candidate.venue) {
    const source = [candidate.year, candidate.venue || candidate.metadata_source].filter(Boolean).join(' / ');
    if (source && shouldPatchText(paper.source, source, false)) patch.source = source;
  }

  return patch;
}

function shouldPatchText(current, next, overwrite) {
  const currentText = String(current || '').trim();
  const nextText = String(next || '').trim();
  if (!nextText) return false;
  return overwrite || !currentText;
}

function shouldPatchNumber(current, next, overwrite) {
  const currentNumber = Number.parseInt(current, 10);
  if (!Number.isFinite(next) || next <= 0) return false;
  return overwrite || !Number.isFinite(currentNumber) || currentNumber <= 0;
}

function shouldPatchCitation(paper, next, overwrite) {
  const currentNumber = Number.parseInt(paper.citation_count, 10);
  const currentSource = String(paper.citation_source || '').trim();
  if (!Number.isFinite(next) || next < 0) return false;
  return overwrite || !currentSource || !Number.isFinite(currentNumber) || currentNumber <= 0;
}

async function applyMetadataBackfill(env, paper, patch, actor) {
  const fields = [
    'abstract',
    'doi',
    'arxiv_id',
    'openreview_id',
    'published_at',
    'citation_count',
    'citation_source',
    'metadata_source',
    'metadata_checked_at',
    'canonical_url',
    'source',
    'link',
    'authors'
  ].filter((field) => Object.hasOwn(patch, field));

  if (!fields.length) return;

  const updatedAt = new Date().toISOString();
  const sets = [...fields, 'updated_by', 'updated_at'].map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => patch[field]);
  await env.DB.prepare(`UPDATE papers SET ${sets} WHERE id = ?`).bind(...values, actor, updatedAt, paper.id).run();
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

async function updatePaper(request, env, id) {
  const data = await readJson(request);
  const current = await env.DB.prepare('SELECT updated_at FROM papers WHERE id = ?').bind(id).first();
  if (!current) {
    return json({ error: 'Not found' }, 404);
  }

  const expectedUpdatedAt = data._expected_updated_at || data.updated_at || '';
  if (expectedUpdatedAt && current.updated_at && expectedUpdatedAt !== current.updated_at) {
    return json({
      error: 'Conflict',
      message: '这篇文献已被其他成员更新，请刷新后再编辑。',
      currentUpdatedAt: current.updated_at
    }, 409);
  }

  const paper = normalizePaper({
    ...data,
    id,
    updated_by: normalizeActor(data.updated_by),
    updated_at: new Date().toISOString()
  });

  const updateFields = FIELDS.filter((field) => field !== 'id' && field !== 'created_at');
  const sets = updateFields.map((field) => `${field} = ?`).join(', ');
  const values = updateFields.map((field) => paper[field]);

  const result = await env.DB.prepare(`UPDATE papers SET ${sets} WHERE id = ?`).bind(...values, id).run();
  const row = await env.DB.prepare('SELECT * FROM papers WHERE id = ?').bind(id).first();
  return json(normalizeRow(row));
}

async function deletePaper(env, id) {
  await env.DB.prepare('DELETE FROM comments WHERE paper_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM favorites WHERE paper_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM papers WHERE id = ?').bind(id).run();
  return json({ success: true });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function registerUser(request, env) {
  const data = await readJson(request);
  const username = String(data.username || '').trim();
  const password = String(data.password || '').trim();
  if (!username || !password) {
    return json({ error: 'Username and password are required' }, 400);
  }
  if (username.length < 2 || username.length > 32) {
    return json({ error: 'Username must be 2-32 characters' }, 400);
  }
  if (password.length < 4) {
    return json({ error: 'Password must be at least 4 characters' }, 400);
  }
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    return json({ error: 'Username already exists' }, 409);
  }
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).bind(userId, username, await hashPassword(password), now).run();
  return json({ username }, 201);
}

async function loginUser(request, env) {
  const data = await readJson(request);
  const username = String(data.username || '').trim();
  const password = String(data.password || '').trim();
  if (!username || !password) {
    return json({ error: 'Username and password are required' }, 400);
  }
  const row = await env.DB.prepare('SELECT username, password_hash FROM users WHERE username = ?').bind(username).first();
  if (!row || row.password_hash !== await hashPassword(password)) {
    return json({ error: 'Invalid username or password' }, 401);
  }
  return json({ username });
}

async function toggleFavorite(request, env, paperId) {
  const data = await readJson(request);
  const username = request.headers.get('X-User-Name') || '';
  if (!username) {
    return json({ error: 'Login required' }, 401);
  }
  const favorite = data.favorite === true;
  const exists = await env.DB.prepare('SELECT 1 FROM papers WHERE id = ?').bind(paperId).first();
  if (!exists) {
    return json({ error: 'Not found' }, 404);
  }
  if (favorite) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO favorites (user_id, paper_id, created_at) VALUES (?, ?, ?)'
    ).bind(username, paperId, new Date().toISOString()).run();
  } else {
    await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND paper_id = ?').bind(username, paperId).run();
  }
  return json({ favorite: favorite ? '是' : '否' });
}

async function importPapers(request, env) {
  const data = await readJson(request);
  const papers = Array.isArray(data.papers) ? data.papers : [];
  const mode = data.mode === 'upsert' ? 'upsert' : 'skip';
  if (papers.length === 0) {
    return json({ error: 'No papers provided' }, 400);
  }

  const now = new Date().toISOString();
  let duplicateIds = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const existingRows = await env.DB.prepare('SELECT id FROM papers').all();
  const existingIds = new Set(existingRows.results.map((row) => row.id));
  const seenIncomingIds = new Set();
  const statements = [];

  for (const paper of papers) {
    const normalized = normalizePaper({
      ...paper,
      id: paper.id || crypto.randomUUID(),
      created_at: paper.created_at || now,
      updated_at: now
    });

    const duplicateInDb = existingIds.has(normalized.id);
    const duplicateInFile = seenIncomingIds.has(normalized.id);
    if (duplicateInDb || duplicateInFile) duplicateIds += 1;

    if (mode === 'skip') {
      if (duplicateInDb || duplicateInFile) {
        skipped += 1;
      } else {
        imported += 1;
        statements.push(insertPaperStatement(env, normalized, 'INSERT OR IGNORE'));
      }
    } else {
      if (!duplicateInFile) {
        if (duplicateInDb) {
          updated += 1;
        } else {
          imported += 1;
        }
      }
      statements.push(upsertPaperStatement(env, normalized));
    }

    seenIncomingIds.add(normalized.id);
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return json({
    imported,
    updated,
    skipped,
    duplicateIds,
    mode
  });
}

async function exportPapers(env) {
  const result = await env.DB.prepare('SELECT * FROM papers').all();
  return json({
    version: 1,
    exportedAt: new Date().toISOString(),
    papers: normalizeRows(result.results)
  });
}

async function getStats(env) {
  const total = await env.DB.prepare('SELECT COUNT(*) as c FROM papers').first('c');
  const shared = await env.DB.prepare("SELECT COUNT(*) as c FROM papers WHERE shared = '是'").first('c');
  const averageScore = await env.DB.prepare(
    'SELECT AVG(relevance*0.3 + novelty*0.2 + evidence*0.2 + inspiration*0.2 + reproducibility*0.1) as avg FROM papers'
  ).first('avg');
  const rows = await env.DB.prepare('SELECT category, categories FROM papers').all();
  const categories = {};
  for (const row of rows.results) {
    for (const category of parseList(row.categories || row.category)) {
      categories[category] = (categories[category] || 0) + 1;
    }
  }

  return json({
    total: total || 0,
    shared: shared || 0,
    averageScore: Math.round((averageScore || 0) * 100) / 100,
    categories
  });
}

async function insertPaper(env, paper) {
  await insertPaperStatement(env, paper).run();
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeTodoRow(row) {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload || '{}');
    return normalizeRow({
      ...payload,
      id: row.id || payload.id,
      created_at: payload.created_at || row.created_at || '',
      updated_at: payload.updated_at || row.updated_at || ''
    });
  } catch {
    return null;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store'
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
