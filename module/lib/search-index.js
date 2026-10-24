'use strict'

const crypto = require('crypto')
const { htmlToSections, chunkSections, tokenize, queryTokens } = require('./text')
const { Bm25 } = require('./bm25')
const { dot, encodeVector, decodeVector } = require('./vectors')
const { parseQuery, bestPerPage, fuse } = require('./fusion')

const DEFAULTS = {
  mode: 'hybrid',
  chunkSize: 1500,
  chunkOverlap: 200,
  batchSize: 16,
  semanticMinScore: 0.3,
  semanticRelativeCutoff: 0.8,
  keywordRelativeCutoff: 0.25,
  semanticWeight: 0.5,
  candidates: 50,
  maxHits: 100,
  queryInstruction: 'Given a search query, retrieve relevant wiki passages that answer the query',
  excludePaths: [],
  retryBaseMs: 30000,
  retryMaxMs: 600000
}

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex')
const chunkKey = (pageId, chunkIndex) => `${pageId}:${chunkIndex}`

/**
 * In-memory search index over page chunks, persisted through a `store`.
 *
 * Chunk 0 of every page is a header (title, description, path); the other
 * chunks are heading-based sections of the rendered page. Keyword search is
 * BM25 over all chunks, semantic search is cosine similarity over chunk
 * embeddings. Embeddings are computed in the background, one batch at a
 * time, so page saves never wait for the embedding endpoint.
 */
class SearchIndex {
  /**
   * @param {object} deps
   * @param {object} deps.store     { loadAll, replacePage, deletePage, updateEmbedding, clear }
   * @param {object} deps.embedder  { enabled, modelKey, embed(texts) } for indexing
   * @param {object} [deps.queryEmbedder]  same vector space, typically with a shorter timeout
   * @param {object} [deps.logger]  { info, warn, error }
   * @param {object} [deps.options]
   */
  constructor ({ store, embedder, queryEmbedder, logger = console, options = {} }) {
    this.store = store
    this.embedder = embedder
    this.queryEmbedder = queryEmbedder || embedder
    this.logger = logger
    this.opts = { ...DEFAULTS, ...options }
    this.pages = new Map() // pageId -> { path, locale, title, chunks: [{ chunkIndex, heading, body, hash, vec }] }
    this.bm25 = new Bm25()
    this._queue = Promise.resolve()
    this._worker = null
    this._retryTimer = null
    this._retryDelay = 0
    this._stopped = false
    this._lastFallbackWarn = 0
  }

  // ------------------------------------------------------------------ state

  /** Rebuild memory state from the store. */
  async load () {
    this.pages.clear()
    this.bm25.clear()
    const rows = await this.store.loadAll()
    const grouped = new Map()
    for (const r of rows) {
      if (!grouped.has(r.pageId)) grouped.set(r.pageId, [])
      grouped.get(r.pageId).push(r)
    }
    for (const [pageId, list] of grouped) {
      list.sort((a, b) => a.chunkIndex - b.chunkIndex)
      const head = list.find(r => r.chunkIndex === 0) || list[0]
      this._setPage(pageId, {
        path: head.path,
        locale: head.locale,
        title: head.chunkIndex === 0 ? head.heading : '',
        chunks: list.map(r => ({
          chunkIndex: r.chunkIndex,
          heading: r.heading || '',
          body: r.body || '',
          hash: r.hash,
          vec: r.embedding && r.embeddingModel === this.embedder.modelKey ? decodeVector(r.embedding) : null
        }))
      })
    }
    this.schedule()
    return { pages: this.pages.size, chunks: rows.length }
  }

  get stats () {
    let chunks = 0
    let embedded = 0
    for (const p of this.pages.values()) {
      chunks += p.chunks.length
      embedded += p.chunks.filter(c => c.vec).length
    }
    return { pages: this.pages.size, chunks, embedded, pending: chunks - embedded }
  }

  isExcluded (path) {
    return this.opts.excludePaths.some(prefix => prefix && path.startsWith(prefix))
  }

  /** Serialize writes so concurrent hooks cannot interleave. */
  _serial (fn) {
    const run = this._queue.then(fn, fn)
    this._queue = run.catch(() => {})
    return run
  }

  _setPage (pageId, page) {
    this._dropFromBm25(pageId)
    this.pages.set(pageId, page)
    for (const c of page.chunks) this.bm25.add(chunkKey(pageId, c.chunkIndex), this._tokens(page, c))
  }

  _dropFromBm25 (pageId) {
    const old = this.pages.get(pageId)
    if (old) for (const c of old.chunks) this.bm25.remove(chunkKey(pageId, c.chunkIndex))
  }

  _tokens (page, c) {
    if (c.chunkIndex === 0) {
      // header: title counts three times, description twice, path once
      const t = tokenize(c.heading)
      const d = tokenize(c.body)
      return [...t, ...t, ...t, ...d, ...d, ...tokenize(page.path)]
    }
    return [...tokenize(c.heading), ...tokenize(c.body)]
  }

  _embedText (page, c) {
    if (c.chunkIndex === 0) return [c.heading, c.body].filter(Boolean).join('\n')
    return [page.title, c.heading, c.body].filter(Boolean).join('\n')
  }

  // --------------------------------------------------------------- indexing

  /**
   * Index or re-index one page. Unpublished, private and excluded pages are
   * removed instead. Unchanged chunks keep their embeddings.
   * @param {{id:number, path:string, locale:string, title:string, description:string, render:string, isPublished?:boolean, isPrivate?:boolean}} page
   */
  indexPage (page) {
    return this._serial(async () => {
      if (page.isPublished === false || page.isPrivate === true || this.isExcluded(page.path)) {
        await this._remove(page.id)
        return 0
      }
      const old = this.pages.get(page.id)
      const oldByHash = new Map((old ? old.chunks : []).filter(c => c.vec).map(c => [c.hash, c.vec]))
      const entry = { path: page.path, locale: page.locale, title: page.title || '', chunks: [] }
      const sections = chunkSections(htmlToSections(page.render || ''), {
        size: this.opts.chunkSize, overlap: this.opts.chunkOverlap
      })
      const raw = [{ heading: page.title || '', body: page.description || '' }, ...sections.map(s => ({ heading: s.heading, body: s.text }))]
      raw.forEach((c, i) => {
        const chunk = { chunkIndex: i, heading: c.heading, body: c.body, hash: '', vec: null }
        chunk.hash = sha1(this._embedText(entry, chunk))
        chunk.vec = oldByHash.get(chunk.hash) || null
        entry.chunks.push(chunk)
      })
      if (old && old.path === entry.path && old.locale === entry.locale && old.title === entry.title &&
          old.chunks.length === entry.chunks.length && old.chunks.every((c, i) => c.hash === entry.chunks[i].hash)) {
        return entry.chunks.length // unchanged: keep stored rows and embeddings as they are
      }
      const modelKey = this.embedder.modelKey
      await this.store.replacePage(page.id, entry.chunks.map(c => ({
        pageId: page.id,
        locale: entry.locale,
        path: entry.path,
        chunkIndex: c.chunkIndex,
        heading: c.heading,
        body: c.body,
        hash: c.hash,
        embedding: c.vec ? encodeVector(c.vec) : null,
        embeddingModel: c.vec ? modelKey : null
      })))
      this._setPage(page.id, entry)
      this.schedule()
      return entry.chunks.length
    })
  }

  removePage (pageId) {
    return this._serial(() => this._remove(pageId))
  }

  /** Remove every indexed page whose id is not in `pageIds` (pages deleted while the engine was off). */
  retainOnly (pageIds) {
    return this._serial(async () => {
      let removed = 0
      for (const id of [...this.pages.keys()]) {
        if (!pageIds.has(id)) { await this._remove(id); removed++ }
      }
      return removed
    })
  }

  async _remove (pageId) {
    await this.store.deletePage(pageId)
    this._dropFromBm25(pageId)
    this.pages.delete(pageId)
  }

  clear () {
    return this._serial(async () => {
      await this.store.clear()
      this.pages.clear()
      this.bm25.clear()
    })
  }

  // ------------------------------------------------------- embedding worker

  /** Start the background embedding worker if there is work and it is idle. */
  schedule () {
    if (this._stopped || this._worker || this._retryTimer || !this.embedder.enabled) return
    if (!this._nextBatch().length) return
    this._worker = this._work().finally(() => { this._worker = null })
  }

  _nextBatch () {
    const batch = []
    for (const [pageId, page] of this.pages) {
      for (const c of page.chunks) {
        if (!c.vec) batch.push({ pageId, page, chunk: c })
        if (batch.length >= this.opts.batchSize) return batch
      }
    }
    return batch
  }

  async _work () {
    for (;;) {
      if (this._stopped) return
      const batch = this._nextBatch()
      if (!batch.length) return
      let vectors
      try {
        vectors = await this.embedder.embed(batch.map(b => this._embedText(b.page, b.chunk)))
        this._retryDelay = 0
      } catch (err) {
        this._retryDelay = Math.min(this.opts.retryMaxMs, this._retryDelay ? this._retryDelay * 2 : this.opts.retryBaseMs)
        this.logger.warn(`(SEARCH/SEMANTIC) Embedding failed, retrying in ${Math.round(this._retryDelay / 1000)}s: ${err.message}`)
        this._retryTimer = setTimeout(() => { this._retryTimer = null; this.schedule() }, this._retryDelay)
        if (this._retryTimer.unref) this._retryTimer.unref()
        return
      }
      const modelKey = this.embedder.modelKey
      for (let i = 0; i < batch.length; i++) {
        const { pageId, page, chunk } = batch[i]
        // the page may have been re-indexed or removed while we waited
        if (this.pages.get(pageId) !== page || !page.chunks.includes(chunk)) continue
        chunk.vec = vectors[i]
        await this.store.updateEmbedding({
          pageId, chunkIndex: chunk.chunkIndex, hash: chunk.hash, embedding: encodeVector(chunk.vec), embeddingModel: modelKey
        })
      }
    }
  }

  /** Resolves once no embedding work is left (or the worker is waiting to retry). */
  async idle () {
    while (this._worker) await this._worker
  }

  stop () {
    this._stopped = true
    if (this._retryTimer) clearTimeout(this._retryTimer)
    this._retryTimer = null
  }

  // ------------------------------------------------------------------ query

  _pageFilter ({ path, locale } = {}) {
    return pageId => {
      const p = this.pages.get(pageId)
      if (!p) return false
      if (locale && p.locale !== locale) return false
      if (path && !p.path.startsWith(path)) return false
      return !this.isExcluded(p.path)
    }
  }

  /** Drop pages scoring below `ratio` × the best score; keeps result lists short and relevant. */
  _cut (ranked, ratio) {
    if (!ranked.length || !(ratio > 0)) return ranked.slice(0, this.opts.candidates)
    const min = ranked[0][1] * ratio
    return ranked.filter(([, s]) => s >= min).slice(0, this.opts.candidates)
  }

  /**
   * A compound like `10.10.0.133` is tokenized whole and split. If the
   * whole compound is indexed, search for it alone; its parts would only add
   * pages that share fragments (other IPs, other paths).
   */
  _compoundAware (tokens) {
    const drop = new Set()
    for (const t of tokens) {
      if (/[._\-:/@]/.test(t) && this.bm25.postings.has(t)) {
        for (const part of t.split(/[._\-:/@]/)) drop.add(part)
      }
    }
    const kept = tokens.filter(t => !drop.has(t))
    return kept.length ? kept : tokens
  }

  _keyword (text, pageOk) {
    const tokens = this._compoundAware(queryTokens(text))
    if (!tokens.length) return []
    const scores = this.bm25.search(tokens, id => pageOk(Number(id.split(':')[0])))
    return this._cut(bestPerPage(scores, id => Number(id.split(':')[0])), this.opts.keywordRelativeCutoff)
  }

  async _semantic (text, pageOk) {
    const instr = (this.opts.queryInstruction || '').trim()
    const [qv] = await this.queryEmbedder.embed([instr ? `Instruct: ${instr}\nQuery: ${text}` : text])
    const scores = new Map()
    for (const [pageId, page] of this.pages) {
      if (!pageOk(pageId)) continue
      for (const c of page.chunks) {
        if (!c.vec) continue
        const s = dot(qv, c.vec)
        if (s >= this.opts.semanticMinScore) scores.set(chunkKey(pageId, c.chunkIndex), s)
      }
    }
    return this._cut(bestPerPage(scores, id => Number(id.split(':')[0])), this.opts.semanticRelativeCutoff)
  }

  /**
   * @param {string} q   query, optionally prefixed with `kw:`, `sem:` or `hyb:`
   * @param {{path?: string, locale?: string}} [filters]
   * @returns {Promise<{mode: string, fallback: boolean, results: {pageId: number, score: number}[]}>}
   */
  async query (q, filters = {}) {
    const { mode, text } = parseQuery(q, this.opts.mode)
    if (!text) return { mode, fallback: false, results: [] }
    const pageOk = this._pageFilter(filters)
    let used = mode
    let fallback = false
    let ranked

    const kw = mode === 'semantic' ? [] : this._keyword(text, pageOk)
    if (mode === 'keyword') {
      ranked = kw
    } else {
      let sem = null
      if (this.embedder.enabled && this.stats.embedded > 0) {
        try {
          sem = await this._semantic(text, pageOk)
        } catch (err) {
          const now = Date.now()
          if (now - this._lastFallbackWarn > 60000) {
            this._lastFallbackWarn = now
            this.logger.warn(`(SEARCH/SEMANTIC) Query embedding failed, using keyword search only: ${err.message}`)
          }
        }
      }
      if (sem === null) {
        used = 'keyword'
        fallback = true
        ranked = mode === 'semantic' ? this._keyword(text, pageOk) : kw
      } else if (mode === 'semantic') {
        ranked = sem
      } else {
        ranked = fuse(kw, sem, { semanticWeight: this.opts.semanticWeight })
      }
    }
    return {
      mode: used,
      fallback,
      results: ranked.slice(0, this.opts.maxHits).map(([pageId, score]) => ({ pageId, score }))
    }
  }
}

module.exports = { SearchIndex, DEFAULTS }
