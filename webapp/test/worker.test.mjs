import test from 'node:test';
import assert from 'node:assert/strict';

import { importPapers, listPapers } from '../src/worker.js';

test('listPapers loads favorites without binding every paper id', async () => {
  const papers = Array.from({ length: 101 }, (_, index) => ({
    id: `paper-${index + 1}`,
    title: `Paper ${index + 1}`
  }));
  const queries = [];
  const env = {
    DB: {
      prepare(sql) {
        queries.push(sql);
        if (sql.startsWith('SELECT * FROM papers')) {
          return { all: async () => ({ results: papers }) };
        }
        return {
          bind(...values) {
            assert.deepEqual(values, ['reader']);
            return { all: async () => ({ results: [{ paper_id: 'paper-101' }] }) };
          }
        };
      }
    }
  };

  const response = await listPapers(new Request('https://example.test/api/papers', {
    headers: { 'X-User-Name': 'reader' }
  }), env);
  const body = await response.json();

  assert.equal(body.papers.length, 101);
  assert.equal(body.papers[100].favorite, '是');
  assert.equal(queries[1], 'SELECT paper_id FROM favorites WHERE user_id = ?');
});

test('importPapers splits more than 100 writes into safe batches', async () => {
  const batchSizes = [];
  const env = {
    DB: {
      prepare(sql) {
        if (sql === 'SELECT id FROM papers') {
          return { all: async () => ({ results: [] }) };
        }
        return { bind: (...values) => ({ sql, values }) };
      },
      async batch(statements) {
        batchSizes.push(statements.length);
      }
    }
  };
  const papers = Array.from({ length: 101 }, (_, index) => ({
    id: `import-${index + 1}`,
    title: `Imported Paper ${index + 1}`
  }));

  const response = await importPapers(new Request('https://example.test/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ papers, mode: 'skip' })
  }), env);
  const body = await response.json();

  assert.equal(body.imported, 101);
  assert.deepEqual(batchSizes, [50, 50, 1]);
});
