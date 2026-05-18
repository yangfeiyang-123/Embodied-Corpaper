import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMetadataQuery,
  detectDuplicate,
  extractArxivId,
  extractOpenReviewId,
  normalizeCandidate,
  normalizeTitle,
  searchCrossref,
  searchArxivByTitle,
  searchMetadata,
  searchOpenAlex,
  searchSemanticScholar,
  similarityScore
} from '../src/metadata.js';

test('classifyMetadataQuery identifies arXiv URLs', () => {
  assert.deepEqual(classifyMetadataQuery('https://arxiv.org/abs/2401.12345'), {
    type: 'arxiv',
    value: '2401.12345'
  });
  assert.deepEqual(classifyMetadataQuery('https://arxiv.org/abs/2605.13083'), {
    type: 'arxiv',
    value: '2605.13083'
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
  assert.equal(extractArxivId('arXiv ID 2502.19902'), '2502.19902');
});

test('extractArxivId reads modern arXiv URL variants', () => {
  assert.equal(extractArxivId('https://arxiv.org/abs/2605.13083'), '2605.13083');
  assert.equal(extractArxivId('https://arxiv.org/abs/2605.13083v1'), '2605.13083');
  assert.equal(extractArxivId('https://arxiv.org/pdf/2605.13083.pdf'), '2605.13083');
  assert.equal(extractArxivId('<https://arxiv.org/abs/2605.13083>'), '2605.13083');
  assert.equal(extractArxivId('https://arxiv.org/abs/2605.13083?context=cs.RO。'), '2605.13083');
});

test('extractArxivId ignores non-arXiv DOI suffixes that look similar', () => {
  assert.equal(extractArxivId('10.1109/cvpr52734.2025.00845'), '');
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

test('normalizeCandidate keeps normalized publication and citation metadata when provided', () => {
  assert.deepEqual(
    normalizeCandidate({
      title: 'A Paper',
      published_at: '2024-05-03',
      citation_count: '42',
      citation_source: 'openalex'
    }),
    {
      title: 'A Paper',
      published_at: '2024-05-03',
      citation_count: 42,
      citation_source: 'openalex',
      doi: '',
      arxiv_id: '',
      openreview_id: '',
      canonical_url: '',
      authors: '',
      institutions: ''
    }
  );
});

test('searchOpenAlex maps cited_by_count into citation metadata', async () => {
  const results = await searchOpenAlex('A Paper', {
    fetch: async () => new Response(JSON.stringify({
      results: [{
        display_name: 'A Paper',
        publication_date: '2024-05-03',
        publication_year: 2024,
        cited_by_count: 17,
        doi: 'https://doi.org/10.1234/example',
        primary_location: {
          source: { display_name: 'Test Journal' }
        }
      }]
    }), { status: 200 })
  });

  assert.equal(results[0].citation_count, 17);
  assert.equal(results[0].citation_source, 'openalex');
  assert.equal(results[0].published_at, '2024-05-03');
});

test('searchCrossref maps is-referenced-by-count into citation metadata', async () => {
  const results = await searchCrossref('10.1234/example', 'doi', {
    fetch: async () => new Response(JSON.stringify({
      message: {
        title: ['A Paper'],
        DOI: '10.1234/example',
        published: { 'date-parts': [[2024, 5, 3]] },
        'is-referenced-by-count': 9
      }
    }), { status: 200 })
  });

  assert.equal(results[0].citation_count, 9);
  assert.equal(results[0].citation_source, 'crossref');
  assert.equal(results[0].published_at, '2024-05-03');
});

test('searchSemanticScholar maps publication date and citation count', async () => {
  const results = await searchSemanticScholar('10.1234/example', 'doi', {
    fetch: async () => new Response(JSON.stringify({
      title: 'A Paper',
      abstract: 'A short abstract.',
      externalIds: {
        DOI: '10.1234/example',
        ArXiv: '2401.12345'
      },
      authors: [{ name: 'Ada Lovelace' }],
      venue: 'Test Conference',
      year: 2024,
      publicationDate: '2024-06-01',
      citationCount: 33,
      url: 'https://www.semanticscholar.org/paper/example'
    }), { status: 200 })
  });

  assert.equal(results[0].citation_count, 33);
  assert.equal(results[0].citation_source, 'semantic_scholar');
  assert.equal(results[0].published_at, '2024-06-01');
  assert.equal(results[0].publication_source, 'semantic_scholar');
  assert.equal(results[0].doi, '10.1234/example');
  assert.equal(results[0].arxiv_id, '2401.12345');
});

test('searchArxivByTitle finds recent arXiv-only papers by title', async () => {
  const arxivXml = `
    <feed>
      <entry>
        <id>https://arxiv.org/abs/2605.06388</id>
        <title>Reconstruction or Semantics? What Makes a Latent Space Useful for Robotic World Models</title>
        <summary>We study latent spaces for robotic world models.</summary>
        <published>2026-05-07T12:00:00Z</published>
        <author><name>Nilaksh</name></author>
      </entry>
    </feed>
  `;
  const results = await searchArxivByTitle('Reconstruction or Semantics? What Makes a Latent Space Useful for Robotic World Models', {
    fetch: async () => new Response(arxivXml, { status: 200 })
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].arxiv_id, '2605.06388');
  assert.equal(results[0].published_at, '2026-05-07');
  assert.equal(results[0].metadata_source, 'arxiv');
});

test('searchMetadata includes arXiv title search for title-only records', async () => {
  const title = 'Reconstruction or Semantics? What Makes a Latent Space Useful for Robotic World Models';
  const arxivXml = `
    <feed>
      <entry>
        <id>https://arxiv.org/abs/2605.06388</id>
        <title>${title}</title>
        <summary>We study latent spaces for robotic world models.</summary>
        <published>2026-05-07T12:00:00Z</published>
        <author><name>Nilaksh</name></author>
      </entry>
    </feed>
  `;
  const result = await searchMetadata(title, {}, {
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('export.arxiv.org')) {
        return new Response(arxivXml, { status: 200 });
      }
      if (href.includes('api.semanticscholar.org')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (href.includes('api.openalex.org')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (href.includes('api.crossref.org')) {
        return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${href}`);
    }
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].arxiv_id, '2605.06388');
  assert.equal(result.candidates[0].published_at, '2026-05-07');
});

test('searchMetadata preserves arXiv page date while using Semantic Scholar citation count', async () => {
  const arxivXml = `
    <feed>
      <entry>
        <id>https://arxiv.org/abs/2401.12345</id>
        <title>A Paper</title>
        <summary>arXiv abstract</summary>
        <published>2024-01-02T00:30:00Z</published>
        <author><name>Ada Lovelace</name></author>
      </entry>
    </feed>
  `;

  const result = await searchMetadata('https://arxiv.org/abs/2401.12345', {}, {
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('export.arxiv.org')) {
        return new Response(arxivXml, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
      }
      if (href.includes('api.semanticscholar.org')) {
        return new Response(JSON.stringify({
          title: 'A Paper',
          externalIds: { ArXiv: '2401.12345' },
          authors: [{ name: 'Ada Lovelace' }],
          publicationDate: '2024-05-03',
          citationCount: 11,
          url: 'https://www.semanticscholar.org/paper/example'
        }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${href}`);
    }
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].published_at, '2024-01-01');
  assert.equal(result.candidates[0].publication_source, 'arxiv');
  assert.equal(result.candidates[0].citation_count, 11);
  assert.equal(result.candidates[0].citation_source, 'semantic_scholar');
});

test('searchMetadata ignores empty cache entries for direct arXiv links', async () => {
  const arxivXml = `
    <feed>
      <entry>
        <id>https://arxiv.org/abs/2605.13083</id>
        <title>TouchAnything: A Dataset and Framework for Bimanual Tactile Estimation from Egocentric Video</title>
        <summary>arXiv abstract</summary>
        <published>2026-05-13T06:54:36Z</published>
        <author><name>Jianyi Zhou</name></author>
      </entry>
    </feed>
  `;
  let arxivFetches = 0;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('SELECT result_json')) return { result_json: '[]' };
                return null;
              },
              async run() {
                return {};
              }
            };
          }
        };
      }
    }
  };

  const result = await searchMetadata('https://arxiv.org/abs/2605.13083', env, {
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('export.arxiv.org')) {
        arxivFetches += 1;
        return new Response(arxivXml, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
      }
      if (href.includes('api.semanticscholar.org')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected URL: ${href}`);
    }
  });

  assert.equal(result.fromCache, false);
  assert.equal(arxivFetches, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].arxiv_id, '2605.13083');
});

test('searchMetadata falls back to arXiv abs HTML when Atom API is unavailable', async () => {
  const absHtml = `
    <!doctype html>
    <html>
      <head>
        <meta name="citation_title" content="TriRelVLA: Triadic Relational Structure for Generalizable Embodied Manipulation" />
        <meta name="citation_author" content="Zhou, Hanyu" />
        <meta name="citation_author" content="Ma, Chuanhao" />
        <meta name="citation_author" content="Lee, Gim Hee" />
        <meta name="citation_date" content="2026/05/07" />
        <meta name="citation_arxiv_id" content="2605.05714" />
        <meta name="citation_abstract" content="Vision-language-action models perform well on training-seen robotic tasks." />
      </head>
      <body><div class="dateline">[Submitted on 7 May 2026]</div></body>
    </html>
  `;

  const result = await searchMetadata('https://arxiv.org/abs/2605.05714', {}, {
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('export.arxiv.org')) {
        return new Response('', { status: 504 });
      }
      if (href.includes('arxiv.org/abs/2605.05714')) {
        return new Response(absHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (href.includes('api.semanticscholar.org')) {
        return new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 });
      }
      throw new Error(`unexpected URL: ${href}`);
    }
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, 'TriRelVLA: Triadic Relational Structure for Generalizable Embodied Manipulation');
  assert.equal(result.candidates[0].arxiv_id, '2605.05714');
  assert.equal(result.candidates[0].published_at, '2026-05-07');
  assert.equal(result.candidates[0].authors, 'Zhou, Hanyu; Ma, Chuanhao; Lee, Gim Hee');
});

test('searchMetadata falls back to title-based citation sources for arXiv records', async () => {
  const title = 'Optimus-2: Multimodal Minecraft Agent with Goal-Observation-Action Conditioned Policy';
  const arxivXml = `
    <feed>
      <entry>
        <id>https://arxiv.org/abs/2502.19902</id>
        <title>${title}</title>
        <summary>arXiv abstract</summary>
        <published>2025-02-27T09:18:04Z</published>
        <author><name>Zaijing Li</name></author>
      </entry>
    </feed>
  `;

  const result = await searchMetadata('https://arxiv.org/abs/2502.19902', {}, {
    fetch: async (url) => {
      const href = String(url);
      const decoded = decodeURIComponent(href);
      if (href.includes('export.arxiv.org')) {
        return new Response(arxivXml, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
      }
      if (href.includes('api.semanticscholar.org')) {
        return new Response(JSON.stringify(href.includes('/paper/search') ? { data: [] } : {}), { status: 200 });
      }
      if (href.includes('api.openalex.org') && decoded.includes(title)) {
        return new Response(JSON.stringify({
          results: [{
            display_name: title,
            publication_date: '2025-06-10',
            publication_year: 2025,
            cited_by_count: 0,
            doi: 'https://doi.org/10.1109/cvpr52734.2025.00845'
          }]
        }), { status: 200 });
      }
      if (href.includes('api.openalex.org')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (href.includes('api.crossref.org')) {
        return new Response(JSON.stringify({
          message: {
            items: [{
              title: [title],
              DOI: '10.1109/cvpr52734.2025.00845',
              published: { 'date-parts': [[2025, 6, 10]] },
              'is-referenced-by-count': 6
            }]
          }
        }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${href}`);
    }
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].arxiv_id, '2502.19902');
  assert.equal(result.candidates[0].published_at, '2025-02-27');
  assert.equal(result.candidates[0].citation_count, 6);
  assert.equal(result.candidates[0].citation_source, 'crossref');
  assert.equal(result.candidates[0].doi, '10.1109/cvpr52734.2025.00845');
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
