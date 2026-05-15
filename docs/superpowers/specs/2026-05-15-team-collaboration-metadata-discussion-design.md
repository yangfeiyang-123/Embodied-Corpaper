# Team Collaboration Metadata and Discussion Design

## Purpose

Improve the paper tracker from a shared editing form into a more useful team literature workspace. The next feature set focuses on three workflows:

1. Fast metadata recognition from a pasted paper link, DOI, arXiv ID, OpenReview URL, or title.
2. Duplicate detection before a team member creates another record for the same paper.
3. Threaded discussion under each paper so questions, supplementary links, and reproduction notes stay attached to the paper.

This design intentionally does not include task assignment, deadlines, version restore, AI-generated deep-reading notes, or batch metadata recognition. Those can be designed later after the core collaboration workflow is reliable.

## Current Context

The current app is a single-page HTML application backed by a Cloudflare Worker and Cloudflare D1. It already supports:

- Shared online data through D1.
- Password protection through `APP_PASSWORD`.
- Multiple paper categories.
- Tags and reading status.
- Member name stored in the browser and saved as `created_by` / `updated_by`.
- Basic edit conflict protection through `updated_at`.
- Import/export with duplicate handling by ID.

The current code does not yet store dedicated paper metadata such as DOI, arXiv ID, OpenReview ID, or abstract. It also has no comments table and no external metadata lookup API.

## Selected Approach

Use the "collaboration practical" approach:

- Add metadata recognition to the existing "Add/Edit Paper" modal.
- Add deterministic and fuzzy duplicate checks before applying metadata.
- Add a discussion area on the paper detail view with top-level comments and one-level replies.

This keeps the app lightweight while addressing the most common team problems: manual metadata entry, duplicate records, and scattered discussion.

## Metadata Recognition Workflow

### Entry Point

The Add/Edit Paper modal gets a "Quick Identify" area at the top:

```text
Quick Identify
[Paste arXiv / DOI / OpenReview / title...] [Identify] [Clear Result]
```

The feature appears in both add and edit modes. In add mode it helps create a paper quickly. In edit mode it helps enrich an existing record with missing metadata.

### Input Type Detection

The Worker classifies the user input before querying external sources:

- arXiv URL, such as `https://arxiv.org/abs/2401.12345`
- arXiv ID, such as `2401.12345`
- DOI, such as `10.48550/arXiv.2401.12345`
- OpenReview URL or forum ID
- Plain paper title

### External Source Priority

Use free public sources first. If one source fails, continue to the next source.

1. arXiv for arXiv URLs and arXiv IDs.
2. OpenReview for OpenReview URLs and forum IDs.
3. Crossref for DOI and title lookup.
4. OpenAlex for title fallback and institution metadata.

Semantic Scholar can be added later if its unauthenticated API behavior is stable enough for the deployment environment.

### Unified Candidate Shape

All source-specific results are normalized into this shape:

```json
{
  "title": "...",
  "year": "2024",
  "venue": "ICLR",
  "source": "OpenAlex",
  "authors": "A; B; C",
  "institutions": "MIT; Stanford",
  "abstract": "...",
  "doi": "...",
  "arxiv_id": "...",
  "openreview_id": "...",
  "url": "...",
  "canonical_url": "...",
  "confidence": 0.92
}
```

The frontend uses this normalized result only after the user chooses a candidate.

### Candidate Selection

Even if only one high-confidence result is found, the app shows a confirmation card instead of filling the form automatically. If multiple results are found, the app shows a candidate list.

Each candidate card displays:

- Title
- Authors
- Year and venue
- Source platform
- DOI, arXiv ID, or OpenReview ID if present
- Abstract preview
- Duplicate status

Candidate actions:

- Use this result
- Open existing record, when a definite duplicate exists
- Merge into existing record, when a definite duplicate exists
- Continue as new, when the user deliberately wants a separate record

## Duplicate Detection

Duplicate checks run before a candidate is applied to the form.

### Definite Duplicate

Treat the candidate as an existing paper if any of these values match an existing record:

- DOI
- arXiv ID
- OpenReview ID
- Canonical URL

For definite duplicates, the UI should guide the user toward opening or merging into the existing record rather than creating a new one.

### Suspected Duplicate

If no strong identifier matches, compare normalized titles. Normalize by lowercasing, removing punctuation, collapsing whitespace, and stripping common venue suffix noise. A high similarity score marks the record as a suspected duplicate.

For suspected duplicates, show the existing candidate and ask the user to confirm whether to continue.

### Merge Behavior

Merging metadata into an existing paper updates only factual metadata fields:

- `abstract`
- `doi`
- `arxiv_id`
- `openreview_id`
- `metadata_source`
- `metadata_checked_at`
- `canonical_url`
- Empty paper info fields such as title, source, link, authors may be filled if blank.

Merging must not overwrite deep-reading fields, ratings, categories, tags, or comments.

## Paper Metadata Data Model

Add these columns to `papers`:

- `abstract TEXT`
- `doi TEXT`
- `arxiv_id TEXT`
- `openreview_id TEXT`
- `metadata_source TEXT`
- `metadata_checked_at TEXT`
- `canonical_url TEXT`

These fields store factual metadata only. The abstract is not stored in `oneSentence`, because `oneSentence` is reserved for the team's own reading summary.

## Metadata Cache

Add a metadata cache table in the first implementation. The initial implementation may keep the cache logic simple, but the table should exist so repeated lookups do not require a future schema change.

```sql
CREATE TABLE metadata_cache (
  query TEXT PRIMARY KEY,
  result_json TEXT,
  created_at TEXT
);
```

Cache behavior:

- Exact ID queries are valid for 30 days.
- Title queries are valid for 7 days.
- A "re-identify" action bypasses cache.

The cache reduces external API calls and provides a fallback if a source is temporarily unavailable.

## Metadata API

Add these endpoints to the Worker:

### `POST /api/metadata/search`

Input:

```json
{ "query": "..." }
```

Output:

```json
{
  "queryType": "title",
  "candidates": [
    {
      "title": "...",
      "year": "2024",
      "venue": "ICLR",
      "source": "OpenAlex",
      "authors": "...",
      "institutions": "...",
      "abstract": "...",
      "doi": "...",
      "arxiv_id": "...",
      "openreview_id": "...",
      "url": "...",
      "canonical_url": "...",
      "confidence": 0.92,
      "duplicate": {
        "status": "none",
        "paper": null,
        "reason": ""
      }
    }
  ],
  "fromCache": false
}
```

`duplicate.status` can be:

- `none`
- `definite`
- `suspected`

### `POST /api/papers/:id/metadata`

Applies selected factual metadata to an existing paper. It uses the same edit conflict protection as normal paper updates.

## Discussion Workflow

Each paper detail view gets a discussion area at the bottom.

The discussion area contains:

- A new comment editor.
- A comment type selector.
- Existing comments in chronological order.
- Reply controls under each top-level comment.

Comment types:

- Question
- Inspiration
- Reproduction
- Supplementary material
- Other

The UI supports one level of replies. Top-level comments can have replies, but replies cannot have nested replies. This keeps the discussion readable and avoids a complex forum UI.

## Comments Data Model

Add a `comments` table:

```sql
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  parent_id TEXT,
  author TEXT NOT NULL,
  type TEXT DEFAULT '其他',
  content TEXT NOT NULL,
  deleted TEXT DEFAULT '否',
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX idx_comments_paper_id ON comments(paper_id);
CREATE INDEX idx_comments_parent_id ON comments(parent_id);
CREATE INDEX idx_comments_created_at ON comments(created_at);
```

Rules:

- `parent_id` is empty for top-level comments.
- `parent_id` points to a top-level comment for replies.
- Comments are soft deleted by setting `deleted = '是'`.
- Deleted comments remain visible as "This comment was deleted" when they have replies, preserving thread continuity.
- Author identity uses the member name stored in the browser. If no member name exists, posting a comment prompts for one.

## Comments API

Add these endpoints:

### `GET /api/papers/:id/comments`

Returns all comments for the paper as a thread-friendly flat list ordered by `created_at ASC`.

### `POST /api/papers/:id/comments`

Creates a top-level comment or a reply.

Input:

```json
{
  "parent_id": "",
  "author": "张三",
  "type": "问题",
  "content": "..."
}
```

### `PUT /api/comments/:id`

Updates comment type or content. Because the app does not have real user accounts, the first version allows editing without strict ownership enforcement. The UI should still show member names clearly so social accountability is preserved.

### `DELETE /api/comments/:id`

Soft deletes a comment.

## Frontend Behavior

### Applying Metadata to the Form

When the user chooses a metadata candidate:

- Fill empty fields directly.
- For title, source, link, and authors fields that already contain text, ask whether to keep the existing value or replace it with the recognized value.
- Always update factual hidden metadata fields.
- Do not change categories, tags, reading status, ratings, or deep-reading fields.
- Mark the form as dirty so the user knows they still need to save the paper.

### Detail Metadata Display

The detail view adds a metadata section after basic information:

- Abstract, collapsed to the first three lines by default.
- DOI.
- arXiv ID.
- OpenReview ID.
- Original link and canonical URL.
- Metadata source.
- Last metadata check time.

### Discussion Display

The paper detail view loads comments after the paper detail opens. If comment loading fails, show a non-blocking message and keep the paper detail usable.

Publishing a comment does not save the paper form. It only writes to the comments API.

## Error Handling

Metadata recognition errors should be non-destructive:

- If no reliable result is found, show "No reliable result found. Please fill manually."
- If an external API fails, continue to the next API.
- If all sources fail, leave existing form content unchanged.
- If a candidate looks uncertain, show it as a candidate rather than applying it automatically.

Discussion errors should be localized:

- Comment loading failure does not block paper details.
- Comment posting failure keeps the typed comment in the editor.
- Delete failure leaves the comment visible.

## Testing Strategy

### Metadata Recognition

Test input classification for:

- arXiv URL
- arXiv ID
- DOI
- OpenReview URL
- Plain title

Test normalization from each metadata source with fixture responses.

Test duplicate detection for:

- DOI match
- arXiv ID match
- OpenReview ID match
- Canonical URL match
- Similar title with no strong identifier

### Comments

Test:

- Create top-level comment.
- Create reply.
- Load comment thread.
- Soft delete top-level comment with replies.
- Soft delete reply.
- Update comment content.

### Frontend

Test manually in the deployed app:

- Identify by link.
- Identify by title and choose from candidates.
- Apply metadata to empty form.
- Apply metadata to form with existing values.
- Confirm duplicate prompt appears.
- Add top-level comment and reply.
- Refresh page and verify comments persist.

## Rollout Plan

1. Add D1 migration for paper metadata, metadata cache, and comments.
2. Add Worker metadata search endpoint and source adapters.
3. Add Worker duplicate detection.
4. Add comments API.
5. Add frontend quick identify UI.
6. Add frontend metadata display in detail view.
7. Add frontend discussion UI.
8. Run local Worker verification.
9. Apply remote D1 migration.
10. Deploy to Cloudflare.

The rollout must apply the D1 migration before deploying Worker code that reads or writes the new columns.
