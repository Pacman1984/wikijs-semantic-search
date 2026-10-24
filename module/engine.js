/* global WIKI */
'use strict'

/*
 * Wiki.js 2.x search engine module: semantic + BM25 hybrid search.
 * Install into server/modules/search/semantic/ and enable it under
 * Administration > Search Engine.
 */

const { SearchIndex } = require('./lib/search-index')
const { EmbeddingClient } = require('./lib/embeddings')
const { KnexStore } = require('./lib/knex-store')

const LOG = '(SEARCH/SEMANTIC)'
const QUERY_TIMEOUT_MS = 10000
const PAGE_COLUMNS = ['id', 'path', 'localeCode', 'title', 'description', 'render', 'isPublished', 'isPrivate']
const REBUILD_BATCH = 100

const num = (v, d) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? d : Number(v))

function toPage (row) {
  return {
    id: row.id,
    path: row.path,
    locale: row.localeCode,
    title: row.title,
    description: row.description,
    render: row.render,
    isPublished: Boolean(row.isPublished),
    isPrivate: Boolean(row.isPrivate)
  }
}

module.exports = {
  async activate () {
    // Wiki.js calls this on every save of the search settings. Nothing to do:
    // init() reconciles the index, which is cheap when nothing changed.
  },

  async deactivate () {
    if (this._index) this._index.stop()
    this._index = null
    // the chunk table is kept, so re-enabling does not re-embed unchanged pages
  },

  async init () {
    const c = this.config || {}
    const timeout = num(c.requestTimeout, 60) * 1000
    const embedderOpts = {
      url: c.embeddingUrl,
      model: c.embeddingModel,
      apiKey: c.embeddingApiKey,
      dimensions: num(c.embeddingDimensions, 0)
    }
    this._store = new KnexStore(WIKI.models.knex)
    await this._store.ensureTable()
    if (this._index) this._index.stop()
    this._index = new SearchIndex({
      store: this._store,
      embedder: new EmbeddingClient({ ...embedderOpts, timeoutMs: timeout }),
      // queries get a shorter timeout than background indexing
      queryEmbedder: new EmbeddingClient({ ...embedderOpts, timeoutMs: Math.min(timeout, QUERY_TIMEOUT_MS) }),
      logger: WIKI.logger,
      options: {
        mode: c.mode || 'hybrid',
        queryInstruction: c.queryInstruction ?? '',
        semanticMinScore: num(c.semanticMinScore, 0.3),
        semanticRelativeCutoff: num(c.semanticRelativeCutoff, 0.8),
        keywordRelativeCutoff: num(c.keywordRelativeCutoff, 0.25),
        semanticWeight: num(c.semanticWeight, 0.5),
        chunkSize: Math.max(200, num(c.chunkSize, 1500)),
        chunkOverlap: Math.max(0, num(c.chunkOverlap, 200)),
        batchSize: Math.max(1, num(c.batchSize, 16)),
        maxHits: num(WIKI.config.search && WIKI.config.search.maxHits, 100),
        excludePaths: String(c.excludePaths || '').split(',').map(s => s.trim()).filter(Boolean)
      }
    })
    const loaded = await this._index.load()
    WIKI.logger.info(`${LOG} Loaded ${loaded.pages} pages / ${loaded.chunks} chunks. Embeddings: ${this._index.embedder.enabled ? this._index.embedder.modelKey : 'disabled (keyword only)'}`)
    // catch up with changes made while the engine was off; unchanged pages are skipped
    this.rebuild().catch(err => WIKI.logger.error(`${LOG} Reconciling the index failed: ${err.message}`))
  },

  async query (q, opts = {}) {
    if (!this._index) return { results: [], suggestions: [], totalHits: 0 }
    const res = await this._index.query(q, { path: opts.path, locale: opts.locale })
    const ids = res.results.map(r => r.pageId)
    if (!ids.length) return { results: [], suggestions: [], totalHits: 0 }
    // same shape as the built-in engines; tags are needed for access checks
    const rows = await WIKI.models.pages.query()
      .column('pages.id', 'pages.title', 'pages.description', 'pages.path', 'pages.localeCode as locale')
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => { builder.select('tag') })
      .whereIn('pages.id', ids)
      .where('pages.isPublished', true)
    const byId = new Map(rows.map(r => [r.id, r]))
    const results = ids.map(id => byId.get(id)).filter(Boolean)
    return { results, suggestions: [], totalHits: results.length }
  },

  async created (page) { await this._indexById(page.id) },
  async updated (page) { await this._indexById(page.id) },
  async renamed (page) { await this._indexById(page.id) },
  async deleted (page) {
    if (this._index) await this._index.removePage(page.id)
  },

  /**
   * Re-index every page. Embeddings of unchanged chunks are kept, so this is
   * cheap to run; only new or changed text goes to the embedding endpoint.
   * To recompute all embeddings, change the model or empty the
   * semanticSearchChunks table.
   */
  async rebuild () {
    const index = this._index
    if (!index) return
    WIKI.logger.info(`${LOG} Rebuilding index...`)
    const seen = new Set()
    let lastId = 0
    for (;;) {
      const rows = await WIKI.models.knex('pages').select(PAGE_COLUMNS)
        .where('id', '>', lastId).orderBy('id').limit(REBUILD_BATCH)
      if (!rows.length) break
      for (const row of rows) {
        if (this._index !== index) return // engine re-initialized meanwhile
        seen.add(row.id)
        await index.indexPage(toPage(row))
      }
      lastId = rows[rows.length - 1].id
    }
    const removed = await index.retainOnly(seen)
    const s = index.stats
    WIKI.logger.info(`${LOG} Index ready: ${seen.size} pages checked, ${s.pages} searchable, ${s.chunks} chunks, ${removed} removed, ${s.pending} chunks waiting for embeddings.`)
  },

  async _indexById (id) {
    if (!this._index) return
    const row = await WIKI.models.knex('pages').select(PAGE_COLUMNS).where('id', id).first()
    if (row) await this._index.indexPage(toPage(row))
    else await this._index.removePage(id)
  }
}
