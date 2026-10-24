# Changelog

## 0.1.0 – 2026-10-24

First release.

- Search engine module `semantic` for Wiki.js 2.5.x.
- BM25 keyword search over the full rendered page content, with compound-token handling, accent folding, German/English query stopwords and prefix matching.
- Relative cutoffs for keyword and semantic hits keep result lists short.
- Semantic search through any OpenAI-compatible `/v1/embeddings` endpoint; background embedding queue with retry and backoff.
- Hybrid ranking by weighted reciprocal rank fusion; per-query mode prefixes `kw:`, `sem:`, `hyb:`.
- Index stored in the Wiki.js database (`semanticSearchChunks`), reconciled on startup; unchanged chunks keep their embeddings.
- Keyword fallback when the embedding endpoint is unavailable.
- Excluded path prefixes (default `private/`); unpublished and private pages are never indexed.
- Unit tests and an end-to-end suite against Wiki.js 2.5.317 in Docker.
