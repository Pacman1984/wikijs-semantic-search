'use strict'

/**
 * Small in-memory BM25 index. Documents are identified by string ids.
 *
 * Query terms of at least `prefixMinLength` characters also match indexed
 * terms that start with them (`container` → `containern`, `zugang` →
 * `zugangsdaten`), weighted by `prefixWeight`. This is a cheap stand-in for
 * stemming that works across languages.
 */
class Bm25 {
  constructor ({ k1 = 1.2, b = 0.75, prefixMinLength = 4, prefixWeight = 0.7 } = {}) {
    this.k1 = k1
    this.b = b
    this.prefixMinLength = prefixMinLength
    this.prefixWeight = prefixWeight
    this.docs = new Map() // id -> { tf: Map<term, count>, len }
    this.postings = new Map() // term -> Set<id>
    this.totalLen = 0
  }

  get size () { return this.docs.size }

  add (id, tokens) {
    if (this.docs.has(id)) this.remove(id)
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    this.docs.set(id, { tf, len: tokens.length })
    this.totalLen += tokens.length
    for (const t of tf.keys()) {
      let set = this.postings.get(t)
      if (!set) { set = new Set(); this.postings.set(t, set) }
      set.add(id)
    }
  }

  remove (id) {
    const doc = this.docs.get(id)
    if (!doc) return
    for (const t of doc.tf.keys()) {
      const set = this.postings.get(t)
      if (set) {
        set.delete(id)
        if (set.size === 0) this.postings.delete(t)
      }
    }
    this.totalLen -= doc.len
    this.docs.delete(id)
  }

  clear () {
    this.docs.clear()
    this.postings.clear()
    this.totalLen = 0
  }

  /** Indexed terms matching a query term, with their weight. */
  expand (term) {
    const out = []
    if (this.postings.has(term)) out.push([term, 1])
    if (term.length >= this.prefixMinLength) {
      for (const t of this.postings.keys()) {
        if (t !== term && t.startsWith(term)) out.push([t, this.prefixWeight])
      }
    }
    return out
  }

  /**
   * @param {string[]} queryTokens
   * @param {(id: string) => boolean} [filter]
   * @returns {Map<string, number>} id -> score
   */
  search (queryTokens, filter) {
    const scores = new Map()
    const n = this.docs.size
    if (n === 0) return scores
    const avgLen = this.totalLen / n || 1
    for (const q of new Set(queryTokens)) {
      const best = new Map()
      for (const [term, weight] of this.expand(q)) {
        const ids = this.postings.get(term)
        const df = ids.size
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        for (const id of ids) {
          if (filter && !filter(id)) continue
          const doc = this.docs.get(id)
          const f = doc.tf.get(term)
          const s = weight * idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * doc.len / avgLen))
          if (s > (best.get(id) || 0)) best.set(id, s)
        }
      }
      for (const [id, s] of best) scores.set(id, (scores.get(id) || 0) + s)
    }
    return scores
  }
}

module.exports = { Bm25 }
