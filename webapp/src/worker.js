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
import { detectDuplicate, searchMetadata } from './metadata.js';

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

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      return registerUser(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      return loginUser(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/papers') {
      return listPapers(request, env);
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
