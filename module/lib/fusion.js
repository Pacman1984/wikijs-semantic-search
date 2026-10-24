'use strict'

const MODES = ['hybrid', 'semantic', 'keyword']
const PREFIXES = { 'kw:': 'keyword', 'sem:': 'semantic', 'hyb:': 'hybrid' }

/**
 * Read an optional mode prefix from the query (`kw:`, `sem:`, `hyb:`).
 * @returns {{mode: string, text: string, explicit: boolean}}
 */
function parseQuery (q = '', defaultMode = 'hybrid') {
  const trimmed = String(q).trim()
  const m = /^(kw|sem|hyb):\s*/i.exec(trimmed)
  if (m) {
    return { mode: PREFIXES[`${m[1].toLowerCase()}:`], text: trimmed.slice(m[0].length).trim(), explicit: true }
  }
  return { mode: MODES.includes(defaultMode) ? defaultMode : 'hybrid', text: trimmed, explicit: false }
}

/** Collapse chunk scores to page scores by taking each page's best chunk. */
function bestPerPage (chunkScores, pageOf) {
  const pages = new Map()
  for (const [chunkId, score] of chunkScores) {
    const pageId = pageOf(chunkId)
    if (score > (pages.get(pageId) ?? -Infinity)) pages.set(pageId, score)
  }
  return [...pages].sort((a, b) => b[1] - a[1])
}

/**
 * Weighted reciprocal rank fusion of two ranked lists of [id, score].
 * `semanticWeight` 0.5 treats both lists equally.
 * @returns {[any, number][]} sorted by fused score
 */
function fuse (keywordRanked, semanticRanked, { semanticWeight = 0.5, k = 60 } = {}) {
  const w = Math.min(1, Math.max(0, semanticWeight))
  const scores = new Map()
  keywordRanked.forEach(([id], i) => scores.set(id, (scores.get(id) || 0) + (1 - w) / (k + i + 1)))
  semanticRanked.forEach(([id], i) => scores.set(id, (scores.get(id) || 0) + w / (k + i + 1)))
  return [...scores].sort((a, b) => b[1] - a[1])
}

module.exports = { MODES, parseQuery, bestPerPage, fuse }
