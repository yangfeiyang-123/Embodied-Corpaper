import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMetadataQuery,
  detectDuplicate,
  extractArxivId,
  extractOpenReviewId,
  normalizeCandidate,
  normalizeTitle,
  similarityScore
} from '../src/metadata.js';

test('classifyMetadataQuery identifies arXiv URLs', () => {
  assert.deepEqual(classifyMetadataQuery('https://arxiv.org/abs/2401.12345'), {
    type: 'arxiv',
    value: '2401.12345'
  });
});

test('classifyMetadataQuery identifies DOIs', () => {
  assert.deepEqual(classifyMetadataQuery('10.48550/arXiv.2401.12345'), {
    type: 'doi',
    value: '10.48550/arXiv.2401.12345'
  });
});

test('classifyMetadataQuery identifies OpenReview URLs', () => {
  assert.deepEqual(classifyMetadataQuery('https://openreview.net/forum?id=abc123'), {
    type: 'openreview',
    value: 'abc123'
  });
});

test('classifyMetadataQuery identifies prefixed OpenReview forum IDs', () => {
  assert.deepEqual(classifyMetadataQuery('openreview:abc123'), {
    type: 'openreview',
    value: 'abc123'
  });
});

test('classifyMetadataQuery treats compact model names as titles', () => {
  assert.deepEqual(classifyMetadataQuery('RT-2'), {
    type: 'title',
    value: 'RT-2'
  });
  assert.deepEqual(classifyMetadataQuery('PaLM2'), {
    type: 'title',
    value: 'PaLM2'
  });
  assert.deepEqual(classifyMetadataQuery('AlphaFold2'), {
    type: 'title',
    value: 'AlphaFold2'
  });
});

test('classifyMetadataQuery treats normal paper titles as titles', () => {
  assert.deepEqual(classifyMetadataQuery('Embodied Agents Learn Generalizable Manipulation Skills'), {
    type: 'title',
    value: 'Embodied Agents Learn Generalizable Manipulation Skills'
  });
});

test('normalizeTitle removes punctuation, lowercases, and collapses whitespace', () => {
  assert.equal(normalizeTitle('  Robo-Agent: A Generalist, Vision-Language Agent!!  '), 'robo agent a generalist vision language agent');
});

test('similarityScore is high for similar titles', () => {
  const score = similarityScore(
    'Embodied Agents Learn Generalizable Manipulation Skills',
    'Embodied Agent Learning for Generalizable Manipulation Skill'
  );

  assert.ok(score > 0.8, `expected score above 0.8, got ${score}`);
});

test('extractArxivId reads arXiv IDs from DOI-like strings', () => {
  assert.equal(extractArxivId('10.48550/arXiv.2401.12345'), '2401.12345');
});

test('extractOpenReviewId reads IDs from URLs', () => {
  assert.equal(extractOpenReviewId('https://openreview.net/forum?id=abc123&noteId=def456'), 'abc123');
});

test('extractOpenReviewId reads prefixed forum IDs', () => {
  assert.equal(extractOpenReviewId('forum:abc123'), 'abc123');
});

test('normalizeCandidate returns consistent strings', () => {
  assert.deepEqual(
    normalizeCandidate({
      title: '  A Paper  ',
      authors: [' Ada Lovelace ', ' Grace Hopper '],
      institutions: [' MIT ', ' Stanford '],
      canonical_url: '  https://example.com/paper  ',
      year: 2024
    }),
    {
      title: 'A Paper',
      authors: 'Ada Lovelace; Grace Hopper',
      institutions: 'MIT; Stanford',
      canonical_url: 'https://example.com/paper',
      year: '2024',
      doi: '',
      arxiv_id: '',
      openreview_id: ''
    }
  );
});

test('normalizeCandidate derives canonical_url from url when absent', () => {
  assert.deepEqual(
    normalizeCandidate({
      title: 'A Paper',
      url: '  https://EXAMPLE.com/path/?b=2&a=1#frag  '
    }),
    {
      title: 'A Paper',
      url: 'https://example.com/path?a=1&b=2',
      canonical_url: 'https://example.com/path?a=1&b=2',
      doi: '',
      arxiv_id: '',
      openreview_id: '',
      authors: '',
      institutions: ''
    }
  );
});

test('detectDuplicate reports definite DOI matches before title matches', () => {
  const result = detectDuplicate(
    {
      title: 'A Completely Different Title',
      doi: '10.48550/arXiv.2401.12345'
    },
    [
      {
        title: 'A Completely Different Title',
        doi: '10.0000/not-the-same'
      },
      {
        title: 'Unrelated Existing Record',
        doi: '10.48550/ARXIV.2401.12345'
      }
    ]
  );

  assert.deepEqual(Object.keys(result).sort(), ['paper', 'reason', 'status']);
  assert.equal(result.status, 'definite');
  assert.equal(result.reason, 'doi');
  assert.equal(result.paper.title, 'Unrelated Existing Record');
});

test('detectDuplicate reports definite canonical_url matches', () => {
  const result = detectDuplicate(
    {
      title: 'New Candidate Title',
      canonical_url: 'https://example.com/paper'
    },
    [
      {
        title: 'Existing Canonical URL Record',
        canonical_url: 'https://example.com/paper'
      }
    ]
  );

  assert.deepEqual(result, {
    status: 'definite',
    reason: 'canonical_url',
    paper: {
      title: 'Existing Canonical URL Record',
      canonical_url: 'https://example.com/paper',
      doi: '',
      arxiv_id: '',
      openreview_id: '',
      authors: '',
      institutions: ''
    }
  });
});

test('detectDuplicate reports suspected matches by title similarity', () => {
  const result = detectDuplicate(
    {
      title: 'Embodied Agents Learn Generalizable Manipulation Skills'
    },
    [
      {
        title: 'A Survey of Language Model Reasoning'
      },
      {
        title: 'Embodied Agent Learning for Generalizable Manipulation Skill'
      }
    ]
  );

  assert.deepEqual(Object.keys(result).sort(), ['paper', 'reason', 'score', 'status']);
  assert.equal(result.status, 'suspected');
  assert.equal(result.reason, 'title');
  assert.equal(result.paper.title, 'Embodied Agent Learning for Generalizable Manipulation Skill');
  assert.ok(result.score >= 0.82, `expected score at least 0.82, got ${result.score}`);
});

test('detectDuplicate returns exact none result shape', () => {
  assert.deepEqual(
    detectDuplicate(
      {
        title: 'A Distinct Paper Title'
      },
      [
        {
          title: 'An Unrelated Existing Record'
        }
      ]
    ),
    {
      status: 'none',
      reason: '',
      paper: null
    }
  );
});
