const COMMENT_TYPES = new Set(['问题', '补充资料', '复现记录', '结论讨论', '其他']);

export function normalizeComment(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    paper_id: String(row.paper_id || ''),
    parent_id: String(row.parent_id || ''),
    author: String(row.author || ''),
    type: COMMENT_TYPES.has(row.type) ? row.type : '其他',
    content: String(row.content || ''),
    deleted: row.deleted === '是' ? '是' : '否',
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || '')
  };
}

export function normalizeComments(rows = []) {
  return rows.map(normalizeComment).filter(Boolean);
}

export async function listComments(env, paperId) {
  const result = await env.DB.prepare(
    "SELECT * FROM comments WHERE paper_id = ? AND deleted != '是' ORDER BY created_at ASC"
  ).bind(paperId).all();
  return Response.json({ comments: normalizeComments(result.results || []) }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function createComment(request, env, paperId) {
  const data = await readJson(request);
  const now = new Date().toISOString();
  const comment = normalizeComment({
    id: crypto.randomUUID(),
    paper_id: paperId,
    parent_id: data.parent_id || '',
    author: data.author,
    type: data.type,
    content: data.content,
    deleted: '否',
    created_at: now,
    updated_at: now
  });

  if (!comment.author) {
    return Response.json({ error: 'Author is required' }, { status: 400 });
  }
  if (!comment.content.trim()) {
    return Response.json({ error: 'Content is required' }, { status: 400 });
  }

  if (comment.parent_id) {
    const parent = await env.DB.prepare(
      'SELECT id, parent_id FROM comments WHERE id = ? AND paper_id = ?'
    ).bind(comment.parent_id, paperId).first();
    if (!parent) {
      return Response.json({ error: 'Parent comment not found' }, { status: 404 });
    }
  }

  await env.DB.prepare(
    `INSERT INTO comments
      (id, paper_id, parent_id, author, type, content, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    comment.id,
    comment.paper_id,
    comment.parent_id,
    comment.author,
    comment.type,
    comment.content,
    comment.deleted,
    comment.created_at,
    comment.updated_at
  ).run();

  return Response.json(comment, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function deleteComment(env, commentId) {
  const existing = await env.DB.prepare('SELECT id, paper_id FROM comments WHERE id = ?').bind(commentId).first();
  if (!existing) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const rows = await env.DB.prepare('SELECT id, parent_id FROM comments WHERE paper_id = ?').bind(existing.paper_id).all();
  const ids = descendantIds(commentId, rows.results || []);
  ids.push(commentId);

  await env.DB.prepare(
    `DELETE FROM comments WHERE id IN (${ids.map(() => '?').join(', ')})`
  ).bind(...ids).run();
  return Response.json({ success: true }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}

function descendantIds(parentId, rows) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const key = String(row.parent_id || '');
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(String(row.id || ''));
  }

  const result = [];
  const stack = [...(childrenByParent.get(String(parentId)) || [])];
  while (stack.length) {
    const id = stack.pop();
    result.push(id);
    stack.push(...(childrenByParent.get(id) || []));
  }
  return result;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
