'use strict'

const { tokenize } = require('../../module/lib/text')
const { normalizeVector } = require('../../module/lib/vectors')

/** In-memory stand-in for KnexStore. */
class MemoryStore {
  constructor () { this.rows = [] }
  async loadAll () { return this.rows.map(r => ({ ...r })) }
  async replacePage (pageId, rows) {
    this.rows = this.rows.filter(r => r.pageId !== pageId).concat(rows.map(r => ({ ...r })))
  }
  async deletePage (pageId) { this.rows = this.rows.filter(r => r.pageId !== pageId) }
  async updateEmbedding ({ pageId, chunkIndex, hash, embedding, embeddingModel }) {
    for (const r of this.rows) {
      if (r.pageId === pageId && r.chunkIndex === chunkIndex && r.hash === hash) Object.assign(r, { embedding, embeddingModel })
    }
  }
  async clear () { this.rows = [] }
}

/**
 * Deterministic fake embedder: hashed bag of words with a few synonym
 * groups, so "semantic" matches can be tested without a model.
 */
const SYNONYMS = [['auto', 'car', 'fahrzeug', 'vehicle'], ['backup', 'sicherung', 'kopie'], ['zugang', 'login', 'credentials', 'zugangsdaten']]
class FakeEmbedder {
  constructor ({ dims = 64, model = 'fake', fail = false } = {}) {
    this.dims = dims
    this.model = model
    this.fail = fail
    this.calls = 0
    this.texts = []
  }
  get enabled () { return true }
  get modelKey () { return `${this.model}|default` }
  async embed (texts) {
    this.calls++
    if (this.fail) throw new Error('endpoint down')
    this.texts.push(...texts)
    return texts.map(t => {
      const v = new Array(this.dims).fill(0)
      for (let tok of tokenize(t.replace(/^Instruct:.*\nQuery: /s, ''))) {
        const group = SYNONYMS.find(g => g.includes(tok))
        if (group) tok = group[0]
        let h = 0
        for (const ch of tok) h = (h * 31 + ch.codePointAt(0)) >>> 0
        v[h % this.dims] += 1
      }
      return normalizeVector(v)
    })
  }
}

const silent = { info () {}, warn () {}, error () {} }

function page (id, path, title, html, extra = {}) {
  return { id, path, locale: 'en', title, description: extra.description || '', render: html, isPublished: true, isPrivate: false, ...extra }
}

module.exports = { MemoryStore, FakeEmbedder, silent, page }
