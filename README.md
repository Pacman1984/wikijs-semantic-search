# wikijs-semantic-search

Semantic search for [Wiki.js](https://js.wiki) 2.x. A drop-in search engine module that searches the **full page content** with BM25 and **by meaning** with vector embeddings, then fuses both rankings (hybrid search).

- Works with **any OpenAI-compatible embeddings endpoint**: llama.cpp server, Ollama, vLLM, LocalAI, OpenAI, …
- **No extra infrastructure**: no vector database, no Elasticsearch. The index lives in the Wiki.js database (SQLite, PostgreSQL, MySQL/MariaDB, MS SQL) and in memory.
- Used everywhere Wiki.js search is used: the search bar, the GraphQL API (`pages.search`) and therefore every MCP server or script built on it.
- Users choose the mode per query: `kw:` keyword only, `sem:` semantic only, `hyb:` or no prefix for the default.
- Degrades gracefully: if the embedding endpoint is down, you still get full-text keyword results.

## Why

The built-in `Database - Basic` engine only matches the whole query as one substring of the title, description or path, never the page body. `ray cluster` does not find a page titled "Ray-Cluster", and nothing in the page text is found at all. The PostgreSQL engine adds full-text search but needs Wiki.js to run on PostgreSQL and still does not understand meaning.

With this module, `how do I get the S3 credentials` finds the page that explains *access keys for SeaweedFS*, and `kw: 10.10.0.123` still finds the exact IP.

## Requirements

- Wiki.js **2.5.x** (tested with 2.5.317). Wiki.js 3 has a different module system.
- Node.js 20 or newer (the one Wiki.js runs on).
- Optional: an embeddings endpoint. Without one, the module runs as a better keyword search (BM25 over full content, word splitting, prefix matching).

## Installation

The module is a folder that goes into `server/modules/search/semantic/` of your Wiki.js installation. It has no npm dependencies.

### Bare metal / systemd

```bash
git clone https://github.com/Pacman1984/wikijs-semantic-search.git
cd wikijs-semantic-search
sudo ./scripts/install.sh /opt/wikijs wikijs   # wiki.js dir, systemd unit to restart
```

Wiki.js updates replace `server/`, so run the install script again after every update.

### Docker

Mount the module into the official image:

```yaml
services:
  wiki:
    image: ghcr.io/requarks/wiki:2
    volumes:
      - ./wikijs-semantic-search/module:/wiki/server/modules/search/semantic:ro
```

### Enable it

1. Restart Wiki.js.
2. Go to **Administration → Search Engine**, select **Semantic Search (Embeddings + BM25)**.
3. Enter the embeddings endpoint and model (see below) and click **Apply**.

The index is built in the background right away. Keyword search works immediately; semantic results appear as soon as the embeddings are computed.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| Default Search Mode | `hybrid` | `hybrid`, `semantic` or `keyword`. Overridable per query with a prefix. |
| Embeddings API Base URL | – | OpenAI-compatible base URL **without** `/embeddings`. Empty = keyword only. |
| Embedding Model | – | Changing it re-embeds all pages in the background. |
| API Key | – | Sent as `Authorization: Bearer …`. |
| Embedding Dimensions | `0` | Only for models with shortened (Matryoshka) embeddings, e.g. `text-embedding-3-*`. |
| Query Instruction | *Given a search query, retrieve relevant wiki passages that answer the query* | Instruction-tuned models (Qwen3-Embedding, E5, GTE) get queries as `Instruct: …\nQuery: …`. Clear it for nomic or OpenAI models. |
| Minimum Semantic Similarity | `0.3` | Cosine similarity a passage needs to count as a semantic hit. Model dependent. |
| Semantic Relative Cutoff | `0.8` | Keep semantic hits scoring at least this share of the best hit. Keeps result lists short; `0` disables. |
| Keyword Relative Cutoff | `0.25` | Same for keyword hits: drops pages that share only a minor term with the query. |
| Semantic Weight (Hybrid) | `0.5` | Share of the semantic ranking in hybrid mode. |
| Chunk Size / Overlap | `1500` / `200` | Characters. Pages are split at headings, long sections further. |
| Embedding Batch Size | `16` | Lower it for small or shared GPUs. |
| Request Timeout | `60` s | For indexing. Queries wait at most 10 s, then fall back to keyword results. |
| Excluded Path Prefixes | `private/` | Comma-separated; never indexed nor returned. |

### Endpoint examples

| Server | Base URL | Model | Query Instruction |
|---|---|---|---|
| llama.cpp (`llama-server --embeddings --pooling last`) | `http://gpu-host:8080/v1` | `Qwen/Qwen3-Embedding-4B` | keep default |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` | empty |
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | empty |

## Searching

| Query | Mode |
|---|---|
| `wie komme ich an die S3-Zugangsdaten` | default (hybrid) |
| `kw: 10.10.0.123` | keyword only, exact terms, IPs, error messages |
| `sem: backup strategy` | semantic only |
| `hyb: gitea ssh` | hybrid, regardless of the default |

Path and locale filters of the API (`pages.search(query, path, locale)`) are honoured, and results are filtered by the page permissions of the current user just like with the built-in engines.

## How it works

1. **Chunking.** Each page becomes a header chunk (title, description, path) plus one chunk per heading section of the rendered page; long sections are split with overlap.
2. **Keyword search.** BM25 over all chunks. Compound tokens are indexed whole and split (`ray-cluster` → `ray-cluster`, `ray`, `cluster`; IPs and paths likewise); if a query compound exists as a whole, only the whole is searched, so `10.10.0.133` does not match every page with another `10.10…` address. Accents are folded, common German and English stopwords are ignored in queries, and query words of 4+ characters also match longer word forms (`container` → `containern`). The title counts three times, the description twice.
3. **Semantic search.** Chunks are embedded in the background, one batch at a time; the query is embedded on search and compared by cosine similarity.
4. **Fusion.** Each page is represented by its best chunk; weak hits are cut relative to the best one, then both rankings are combined with weighted reciprocal rank fusion.
5. **Persistence.** Chunks and vectors are stored in the table `semanticSearchChunks` of the Wiki.js database. On startup and on every settings change the index is reconciled with the pages; unchanged chunks keep their embeddings, so only new or edited text is sent to the embedding endpoint.

Memory use is small: vectors of 1,000 chunks with 2,560 dimensions take about 10 MB.

## Operations

- **Rebuild index** in the admin area re-checks every page. It does not recompute embeddings of unchanged text.
- **Recompute all embeddings**: change the model, or empty the `semanticSearchChunks` table and restart.
- **Uninstall**: switch back to another engine, delete the module folder, optionally drop the `semanticSearchChunks` table.
- Log lines are prefixed with `(SEARCH/SEMANTIC)`.

## Development

```bash
npm test            # unit tests, no dependencies needed
npm run test:e2e    # starts Wiki.js 2.5.317, a fake embeddings server and the e2e suite in Docker
```

`WIKI_VERSION=2.5.316 npm run test:e2e` tests against another Wiki.js release.

## License

[AGPL-3.0](LICENSE), the same license as Wiki.js.
