'use strict'

/**
 * Text helpers: turn rendered page HTML into heading-based sections,
 * split sections into chunks and tokenize text for BM25.
 *
 * Dependency-free on purpose, so the module runs inside any Wiki.js 2.x
 * install without touching its node_modules.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  copy: '©', reg: '®', middot: '·', rarr: '→', larr: '←', para: '¶'
}

function decodeEntities (str) {
  return str.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : m
  })
}

/** Strip tags from an HTML fragment, keeping block boundaries as line breaks. */
function htmlToText (html) {
  const text = html
    .replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a[^>]*class="[^"]*toc-anchor[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|pre|blockquote|h[1-6]|table|ul|ol|dt|dd)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .replace(/¶/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Split rendered HTML at h1–h6 into sections.
 * @returns {{heading: string, text: string}[]}
 */
function htmlToSections (html = '') {
  const sections = []
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
  let last = 0
  let heading = ''
  let m
  while ((m = re.exec(html)) !== null) {
    const text = htmlToText(html.slice(last, m.index))
    if (text) sections.push({ heading, text })
    heading = htmlToText(m[2]).replace(/\n/g, ' ')
    last = re.lastIndex
  }
  const tail = htmlToText(html.slice(last))
  if (tail) sections.push({ heading, text: tail })
  return sections
}

/** Hard-split an over-long paragraph on word boundaries with overlap. */
function splitLong (text, size, overlap) {
  const out = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      if (space > start + size / 2) end = space
    }
    out.push(text.slice(start, end).trim())
    if (end >= text.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out.filter(Boolean)
}

/**
 * Turn sections into chunks of at most `size` characters. Paragraphs are
 * kept together where possible; only paragraphs longer than `size` are
 * split, with `overlap` characters repeated between the pieces.
 * @returns {{heading: string, text: string}[]}
 */
function chunkSections (sections, { size = 1500, overlap = 200 } = {}) {
  const chunks = []
  for (const { heading, text } of sections) {
    let buf = ''
    for (const para of text.split('\n')) {
      if (para.length > size) {
        if (buf) { chunks.push({ heading, text: buf }); buf = '' }
        for (const piece of splitLong(para, size, overlap)) chunks.push({ heading, text: piece })
        continue
      }
      if (buf && buf.length + 1 + para.length > size) {
        chunks.push({ heading, text: buf })
        buf = ''
      }
      buf = buf ? `${buf}\n${para}` : para
    }
    if (buf) chunks.push({ heading, text: buf })
  }
  return chunks
}

function normalize (str) {
  return str.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:[._\-:/@][\p{L}\p{N}]+)*/gu
const SEP_RE = /[._\-:/@]/

/**
 * Tokenize text for BM25. Compound tokens such as `10.10.0.133`,
 * `ray-cluster` or `server/modules` are kept whole *and* split into their
 * parts, so both `ray cluster` and `ray-cluster` match.
 * @returns {string[]}
 */
function tokenize (str = '') {
  const tokens = []
  for (const m of normalize(str).matchAll(TOKEN_RE)) {
    const tok = m[0]
    if (SEP_RE.test(tok)) {
      tokens.push(tok)
      for (const part of tok.split(SEP_RE)) if (keep(part)) tokens.push(part)
    } else if (keep(tok)) {
      tokens.push(tok)
    }
  }
  return tokens
}

function keep (tok) {
  return tok.length >= 2 || /^\p{N}$/u.test(tok)
}

// Frequent German and English function words. They are kept in the index
// but ignored in queries, unless a query consists of nothing else.
const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'nicht', 'kein', 'keine', 'ist', 'sind', 'war', 'wird', 'werden', 'wurde', 'sein', 'hat', 'haben',
  'mit', 'von', 'vom', 'zu', 'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'vor', 'für', 'über', 'unter', 'durch', 'gegen', 'ohne', 'um', 'an', 'am', 'im', 'in', 'ins',
  'als', 'wie', 'wo', 'was', 'wer', 'wann', 'warum', 'welche', 'welcher', 'welches', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man', 'mich', 'mir', 'uns',
  'sich', 'auch', 'noch', 'nur', 'schon', 'so', 'dann', 'da', 'dass', 'wenn', 'ob', 'kann', 'können', 'muss', 'müssen', 'soll', 'hier', 'dort', 'jetzt', 'mal',
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'no', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'about', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'i', 'you', 'we', 'they', 'my', 'our', 'can', 'should', 'will', 'would', 'there', 'here'
].map(normalize))

/** Tokens of a query with stopwords removed (all of them kept if nothing else is left). */
function queryTokens (str = '') {
  const all = tokenize(str)
  const content = all.filter(t => !STOPWORDS.has(t))
  return content.length ? content : all
}

module.exports = { decodeEntities, htmlToText, htmlToSections, chunkSections, tokenize, queryTokens, normalize, STOPWORDS }
