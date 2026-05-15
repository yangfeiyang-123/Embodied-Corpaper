#!/usr/bin/env python3
"""
具身智能文献深读记录系统 - 后端服务
Flask + SQLite，单文件启动，零配置。
"""
import os, sys, json, hashlib, secrets
from datetime import datetime
from functools import wraps

from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS

# ===================== Config =====================
APP_PASSWORD = os.environ.get('APP_PASSWORD', '')  # 设置密码保护访问，为空则不验证
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(DATA_DIR, 'papers.db')
INIT_JSON = os.path.join(DATA_DIR, 'papers_from_excel.json')

app = Flask(__name__)
CORS(app)  # 允许跨域，方便前后端分离部署

# ===================== Auth =====================
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not APP_PASSWORD:
            return f(*args, **kwargs)
        auth = request.headers.get('X-App-Password', '')
        if auth != APP_PASSWORD:
            return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return decorated

# ===================== DB =====================
import sqlite3

FIELDS = [
    'id','category','categories','tags','status','week','recorder','readDate','shared',
    'relevance','novelty','evidence','inspiration','reproducibility',
    'title','source','link','direction','oneSentence','authors',
    'task','motivation','dataset','platform','signalAnalysis',
    'methodOverview','methodDetails','trainFlow','hardware',
    'baselines','metrics','overallResults','coreEffect','ablation',
    'inferenceSpeed','innovation1','innovation2','innovation3','innovation4',
    'inspirationNote','limitations','newIdeas',
    'abstract','doi','arxiv_id','openreview_id','metadata_source','metadata_checked_at','canonical_url',
    'created_by','updated_by','created_at','updated_at'
]

def parse_list(value):
    if isinstance(value, list):
        items = value
    else:
        raw = str(value or '')
        for sep in ['，', ';', '；', '\n']:
            raw = raw.replace(sep, ',')
        items = raw.replace('|', ',').split(',')
    seen, result = set(), []
    for item in items:
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result

def normalize_paper(data):
    categories = parse_list(data.get('categories') or data.get('category'))
    tags = parse_list(data.get('tags'))
    normalized = {f: data.get(f, '') for f in FIELDS}
    normalized['categories'] = '|'.join(categories)
    normalized['category'] = normalized.get('category') or (categories[0] if categories else '')
    normalized['tags'] = '|'.join(tags)
    normalized['status'] = normalized.get('status') or '深读中'
    return normalized

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS papers (
            id TEXT PRIMARY KEY,
            category TEXT,
            categories TEXT,
            tags TEXT,
            status TEXT,
            week TEXT,
            recorder TEXT,
            readDate TEXT,
            shared TEXT,
            relevance REAL,
            novelty REAL,
            evidence REAL,
            inspiration REAL,
            reproducibility REAL,
            title TEXT,
            source TEXT,
            link TEXT,
            direction TEXT,
            oneSentence TEXT,
            authors TEXT,
            task TEXT,
            motivation TEXT,
            dataset TEXT,
            platform TEXT,
            signalAnalysis TEXT,
            methodOverview TEXT,
            methodDetails TEXT,
            trainFlow TEXT,
            hardware TEXT,
            baselines TEXT,
            metrics TEXT,
            overallResults TEXT,
            coreEffect TEXT,
            ablation TEXT,
            inferenceSpeed TEXT,
            innovation1 TEXT,
            innovation2 TEXT,
            innovation3 TEXT,
            innovation4 TEXT,
            inspirationNote TEXT,
            limitations TEXT,
            newIdeas TEXT,
            created_by TEXT,
            updated_by TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    ''')
    existing = {row['name'] for row in conn.execute('PRAGMA table_info(papers)').fetchall()}
    extra_columns = {
        'categories': 'TEXT',
        'tags': 'TEXT',
        'status': "TEXT DEFAULT '深读中'",
        'created_by': 'TEXT',
        'updated_by': 'TEXT',
        'abstract': 'TEXT',
        'doi': 'TEXT',
        'arxiv_id': 'TEXT',
        'openreview_id': 'TEXT',
        'metadata_source': 'TEXT',
        'metadata_checked_at': 'TEXT',
        'canonical_url': 'TEXT'
    }
    for name, column_type in extra_columns.items():
        if name not in existing:
            conn.execute(f'ALTER TABLE papers ADD COLUMN {name} {column_type}')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS metadata_cache (
            query TEXT PRIMARY KEY,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    ''')
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
    conn.execute("UPDATE papers SET categories = category WHERE (categories IS NULL OR categories = '') AND category IS NOT NULL AND category != ''")
    conn.commit()
    conn.close()

def row_to_dict(row):
    d = dict(row)
    # Ensure numeric scores are numbers
    for k in ['relevance','novelty','evidence','inspiration','reproducibility']:
        if d.get(k) is not None:
            try:
                d[k] = float(d[k])
            except:
                d[k] = 0
    d['categories'] = parse_list(d.get('categories') or d.get('category'))
    d['tags'] = parse_list(d.get('tags'))
    d['status'] = d.get('status') or '深读中'
    return d

def comment_to_dict(row):
    d = dict(row)
    d['parent_id'] = d.get('parent_id') or ''
    d['deleted'] = d.get('deleted') or '否'
    d['type'] = d.get('type') or '其他'
    return d

def comment_descendant_ids(conn, comment_id, paper_id):
    rows = conn.execute('SELECT id, parent_id FROM comments WHERE paper_id = ?', (paper_id,)).fetchall()
    children_by_parent = {}
    for row in rows:
        children_by_parent.setdefault(row['parent_id'] or '', []).append(row['id'])
    result, stack = [], list(children_by_parent.get(comment_id, []))
    while stack:
        child_id = stack.pop()
        result.append(child_id)
        stack.extend(children_by_parent.get(child_id, []))
    return result

def classify_metadata_query(query):
    text = str(query or '').strip()
    if not text:
        return {'type': 'unknown', 'value': ''}
    lower = text.lower()
    if 'arxiv.org' in lower or lower.startswith('arxiv:'):
        return {'type': 'arxiv', 'value': text}
    if 'openreview.net' in lower or lower.startswith('openreview:') or lower.startswith('forum:'):
        return {'type': 'openreview', 'value': text}
    if lower.startswith('doi:') or lower.startswith('10.'):
        return {'type': 'doi', 'value': text.replace('doi:', '', 1).strip()}
    return {'type': 'title', 'value': text}

def load_initial_data():
    """If DB is empty and papers_from_excel.json exists, load it."""
    conn = get_db()
    cur = conn.execute('SELECT COUNT(*) as c FROM papers')
    count = cur.fetchone()['c']
    if count == 0 and os.path.exists(INIT_JSON):
        with open(INIT_JSON, 'r', encoding='utf-8') as f:
            data = json.load(f)
        papers = data.get('papers', [])
        for p in papers:
            now = datetime.now().isoformat()
            p.setdefault('created_at', now)
            p.setdefault('updated_at', now)
            p = normalize_paper(p)
            fields = FIELDS
            cols = ', '.join(fields)
            placeholders = ', '.join(['?'] * len(fields))
            values = [p.get(f, '') for f in fields]
            conn.execute(f'INSERT INTO papers ({cols}) VALUES ({placeholders})', values)
        conn.commit()
        print(f'Loaded {len(papers)} papers from {INIT_JSON}')
    conn.close()

# ===================== API Routes =====================

@app.route('/api/papers', methods=['GET'])
@require_auth
def list_papers():
    conn = get_db()
    rows = conn.execute('SELECT * FROM papers ORDER BY updated_at DESC').fetchall()
    conn.close()
    return jsonify({'papers': [row_to_dict(r) for r in rows]})

@app.route('/api/papers', methods=['POST'])
@require_auth
def create_paper():
    data = request.get_json(force=True) or {}
    now = datetime.now().isoformat()
    paper_id = data.get('id') or secrets.token_hex(8)
    data['id'] = paper_id
    data.setdefault('created_at', now)
    data['updated_at'] = now
    data = normalize_paper(data)

    fields = FIELDS
    cols = ', '.join(fields)
    placeholders = ', '.join(['?'] * len(fields))
    values = [data.get(f, '') for f in fields]

    conn = get_db()
    conn.execute(f'INSERT INTO papers ({cols}) VALUES ({placeholders})', values)
    conn.commit()
    row = conn.execute('SELECT * FROM papers WHERE id = ?', (paper_id,)).fetchone()
    conn.close()
    return jsonify(row_to_dict(row)), 201

@app.route('/api/papers/<paper_id>', methods=['PUT'])
@require_auth
def update_paper(paper_id):
    data = request.get_json(force=True) or {}
    conn = get_db()
    row = conn.execute('SELECT updated_at FROM papers WHERE id = ?', (paper_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    expected = data.get('_expected_updated_at') or data.get('updated_at') or ''
    if expected and row['updated_at'] and expected != row['updated_at']:
        conn.close()
        return jsonify({'error': 'Conflict', 'message': '这篇文献已被其他成员更新，请刷新后再编辑。'}), 409
    data['updated_at'] = datetime.now().isoformat()
    data = normalize_paper(data)

    fields = [f for f in FIELDS if f not in ['id', 'created_at']]
    sets = ', '.join([f'{f} = ?' for f in fields])
    values = [data.get(f, '') for f in fields] + [paper_id]

    conn.execute(f'UPDATE papers SET {sets} WHERE id = ?', values)
    conn.commit()
    row = conn.execute('SELECT * FROM papers WHERE id = ?', (paper_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(row_to_dict(row))

@app.route('/api/papers/<paper_id>', methods=['DELETE'])
@require_auth
def delete_paper(paper_id):
    conn = get_db()
    conn.execute('DELETE FROM comments WHERE paper_id = ?', (paper_id,))
    conn.execute('DELETE FROM papers WHERE id = ?', (paper_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/metadata/search', methods=['POST'])
@require_auth
def search_metadata():
    data = request.get_json(force=True) or {}
    query_type = classify_metadata_query(data.get('query', ''))
    return jsonify({
        'queryType': query_type,
        'candidates': [],
        'fromCache': False,
        'localMode': True,
        'message': 'Local Flask mode does not perform external metadata lookup. Use Cloudflare Worker mode for recognition.'
    })

@app.route('/api/papers/<paper_id>/comments', methods=['GET'])
@require_auth
def list_comments(paper_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM comments WHERE paper_id = ? AND deleted != '是' ORDER BY created_at ASC",
        (paper_id,)
    ).fetchall()
    conn.close()
    return jsonify({'comments': [comment_to_dict(r) for r in rows]})

@app.route('/api/papers/<paper_id>/comments', methods=['POST'])
@require_auth
def create_comment(paper_id):
    data = request.get_json(force=True) or {}
    author = str(data.get('author') or '').strip()
    content = str(data.get('content') or '').strip()
    parent_id = str(data.get('parent_id') or '').strip()
    comment_type = str(data.get('type') or '其他').strip() or '其他'
    if not author:
        return jsonify({'error': 'Author is required'}), 400
    if not content:
        return jsonify({'error': 'Content is required'}), 400

    conn = get_db()
    if parent_id:
        parent = conn.execute(
            'SELECT id, parent_id FROM comments WHERE id = ? AND paper_id = ?',
            (parent_id, paper_id)
        ).fetchone()
        if not parent:
            conn.close()
            return jsonify({'error': 'Parent comment not found'}), 404

    now = datetime.now().isoformat()
    comment_id = secrets.token_hex(12)
    conn.execute('''
        INSERT INTO comments
        (id, paper_id, parent_id, author, type, content, deleted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '否', ?, ?)
    ''', (comment_id, paper_id, parent_id, author, comment_type, content, now, now))
    conn.commit()
    row = conn.execute('SELECT * FROM comments WHERE id = ?', (comment_id,)).fetchone()
    conn.close()
    return jsonify(comment_to_dict(row)), 201

@app.route('/api/comments/<comment_id>', methods=['DELETE'])
@require_auth
def delete_comment(comment_id):
    conn = get_db()
    row = conn.execute('SELECT id, paper_id FROM comments WHERE id = ?', (comment_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    ids = comment_descendant_ids(conn, comment_id, row['paper_id']) + [comment_id]
    placeholders = ', '.join(['?'] * len(ids))
    conn.execute(f'DELETE FROM comments WHERE id IN ({placeholders})', ids)
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/import', methods=['POST'])
@require_auth
def import_papers():
    data = request.get_json(force=True) or {}
    papers = data.get('papers', [])
    if not papers:
        return jsonify({'error': 'No papers provided'}), 400
    now = datetime.now().isoformat()
    conn = get_db()
    imported = 0
    for p in papers:
        paper_id = p.get('id') or secrets.token_hex(8)
        p['id'] = paper_id
        p.setdefault('created_at', now)
        p['updated_at'] = now
        p = normalize_paper(p)
        fields = FIELDS
        cols = ', '.join(fields)
        placeholders = ', '.join(['?'] * len(fields))
        values = [p.get(f, '') for f in fields]
        try:
            conn.execute(f'INSERT INTO papers ({cols}) VALUES ({placeholders})', values)
            imported += 1
        except sqlite3.IntegrityError:
            # ID conflict, skip or update
            pass
    conn.commit()
    conn.close()
    return jsonify({'imported': imported})

@app.route('/api/export', methods=['GET'])
@require_auth
def export_papers():
    conn = get_db()
    rows = conn.execute('SELECT * FROM papers').fetchall()
    conn.close()
    data = {
        'version': 1,
        'exportedAt': datetime.now().isoformat(),
        'papers': [row_to_dict(r) for r in rows]
    }
    return jsonify(data)

@app.route('/api/stats', methods=['GET'])
@require_auth
def get_stats():
    conn = get_db()
    total = conn.execute('SELECT COUNT(*) as c FROM papers').fetchone()['c']
    shared = conn.execute("SELECT COUNT(*) as c FROM papers WHERE shared = '是'").fetchone()['c']
    avg = conn.execute('SELECT AVG(relevance*0.3 + novelty*0.2 + evidence*0.2 + inspiration*0.2 + reproducibility*0.1) as avg FROM papers').fetchone()['avg'] or 0
    category_rows = conn.execute('SELECT category, categories FROM papers').fetchall()
    conn.close()
    categories = {}
    for row in category_rows:
        for category in parse_list(row['categories'] or row['category']):
            categories[category] = categories.get(category, 0) + 1
    return jsonify({
        'total': total,
        'shared': shared,
        'averageScore': round(avg, 2),
        'categories': categories
    })

# ===================== Static Files =====================
@app.route('/')
def index():
    return send_from_directory(DATA_DIR, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(DATA_DIR, path)

# ===================== Main =====================
if __name__ == '__main__':
    init_db()
    load_initial_data()
    port = int(os.environ.get('PORT', 8088))
    print(f'Starting server on port {port}')
    if APP_PASSWORD:
        print('Password protection is ENABLED')
    else:
        print('Password protection is DISABLED (set APP_PASSWORD env to enable)')
    app.run(host='0.0.0.0', port=port, debug=False)
