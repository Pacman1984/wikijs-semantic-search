'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { SearchIndex } = require('../../module/lib/search-index')
const { MemoryStore, FakeEmbedder, silent, page } = require('./helpers')

function setup (opts = {}) {
  const store = new MemoryStore()
  const embedder = opts.embedder || new FakeEmbedder()
  const index = new SearchIndex({ store, embedder, logger: silent, options: { semanticMinScore: 0.2, ...opts.options } })
  return { store, embedder, index }
}

const PAGES = [
  page(1, 'homelab/gitea', 'Gitea', '<h1>Gitea</h1><p>Git-Server auf LXC 200, IP 10.10.0.123.</p><h2>Zugang</h2><p>SSH als gitea.</p>', { description: 'Git Server' }),
  page(2, 'homelab/seaweedfs', 'SeaweedFS', '<p>S3-Speicher. Es gibt keine Sicherung der Daten.</p>'),
  page(3, 'projects/tennis/overview', 'Tennis', '<p>Wettmodell mit Ray-Cluster und MLflow.</p>'),
  page(4, 'notes/fahrzeug', 'Notizen', '<p>Das Fahrzeug muss zum TÜV.</p>')
]

async function indexAll (index, pages = PAGES) {
  for (const p of pages) await index.indexPage(p)
  await index.idle()
}

test('keyword search finds words in the page body, not only titles', async () => {
  const { index } = setup()
  await indexAll(index)
  const res = await index.query('kw: Ray Cluster')
  assert.equal(res.mode, 'keyword')
  assert.deepEqual(res.results.map(r => r.pageId), [3])
  assert.deepEqual((await index.query('kw: 10.10.0.123')).results.map(r => r.pageId), [1])
})

test('semantic search matches synonyms that keyword search misses', async () => {
  const { index } = setup()
  await indexAll(index)
  assert.equal((await index.query('kw: backup')).results.length, 0)
  const sem = await index.query('sem: backup')
  assert.equal(sem.mode, 'semantic')
  assert.equal(sem.results[0].pageId, 2)
  const car = await index.query('sem: auto')
  assert.equal(car.results[0].pageId, 4)
})

test('hybrid mode is the default and combines keyword and semantic hits', async () => {
  const { index } = setup()
  await indexAll(index)
  const sem = await index.query('backup')
  assert.equal(sem.mode, 'hybrid')
  assert.equal(sem.results[0].pageId, 2, 'semantic-only match is included')
  const kw = await index.query('10.10.0.123')
  assert.equal(kw.results[0].pageId, 1, 'exact keyword match ranks first')
})

test('compound terms found as a whole ignore their parts', async () => {
  const { index } = setup()
  await indexAll(index, [
    page(1, 'a', 'A', '<p>Pfad /opt/wikijs/server</p>'),
    page(2, 'b', 'B', '<p>Pfad /opt/karakeep</p>'),
    page(3, 'c', 'C', '<p>Der Ray Cluster</p>')
  ])
  assert.deepEqual((await index.query('kw: /opt/wikijs/server')).results.map(r => r.pageId), [1])
  assert.deepEqual((await index.query('kw: ray-cluster')).results.map(r => r.pageId), [3], 'parts still help when the compound is not indexed')
})

test('path and locale filters restrict results', async () => {
  const { index } = setup()
  await indexAll(index)
  assert.deepEqual((await index.query('kw: server', { path: 'homelab/' })).results.map(r => r.pageId), [1])
  assert.equal((await index.query('kw: gitea', { locale: 'de' })).results.length, 0)
})

test('unpublished, private and excluded pages are not indexed', async () => {
  const { index, store } = setup({ options: { excludePaths: ['private/'] } })
  await index.indexPage(page(10, 'private/tagebuch', 'Tagebuch', '<p>geheim gitea</p>'))
  await index.indexPage(page(11, 'drafts/x', 'Entwurf', '<p>gitea</p>', { isPublished: false }))
  await index.indexPage(page(12, 'y', 'Privat', '<p>gitea</p>', { isPrivate: true }))
  assert.equal(store.rows.length, 0)
  assert.equal((await index.query('kw: gitea')).results.length, 0)
})

test('unpublishing a page removes it', async () => {
  const { index, store } = setup()
  await indexAll(index)
  await index.indexPage({ ...PAGES[0], isPublished: false })
  assert.equal(store.rows.some(r => r.pageId === 1), false)
  assert.equal((await index.query('kw: gitea')).results.length, 0)
})

test('re-indexing reuses embeddings of unchanged chunks', async () => {
  const { index, embedder } = setup()
  await indexAll(index)
  const before = embedder.texts.length
  const changed = { ...PAGES[0], render: PAGES[0].render.replace('SSH als gitea.', 'SSH als root.') }
  await index.indexPage(changed)
  await index.idle()
  assert.equal(embedder.texts.length - before, 1, 'only the changed section is embedded again')
  assert.ok(embedder.texts.at(-1).includes('SSH als root'))
})

test('re-indexing an unchanged page writes nothing and embeds nothing', async () => {
  const { index, store, embedder } = setup()
  await indexAll(index)
  let writes = 0
  const replace = store.replacePage.bind(store)
  store.replacePage = async (...args) => { writes++; return replace(...args) }
  const calls = embedder.calls
  await indexAll(index)
  assert.equal(writes, 0)
  assert.equal(embedder.calls, calls)
})

test('retainOnly removes pages that no longer exist', async () => {
  const { index, store } = setup()
  await indexAll(index)
  const removed = await index.retainOnly(new Set([1, 3]))
  assert.equal(removed, 2)
  assert.deepEqual([...index.pages.keys()].sort(), [1, 3])
  assert.ok(store.rows.every(r => r.pageId === 1 || r.pageId === 3))
})

test('state survives a reload from the store, including embeddings', async () => {
  const { index, store, embedder } = setup()
  await indexAll(index)
  const fresh = new SearchIndex({ store, embedder, logger: silent, options: { semanticMinScore: 0.2 } })
  const calls = embedder.calls
  await fresh.load()
  await fresh.idle()
  assert.equal(embedder.calls, calls, 'nothing re-embedded after reload')
  assert.deepEqual(fresh.stats, index.stats)
  assert.equal((await fresh.query('sem: backup')).results[0].pageId, 2)
})

test('changing the embedding model re-embeds everything', async () => {
  const { index, store } = setup()
  await indexAll(index)
  const other = new FakeEmbedder({ model: 'other' })
  const fresh = new SearchIndex({ store, embedder: other, logger: silent })
  await fresh.load()
  await fresh.idle()
  assert.equal(fresh.stats.pending, 0)
  assert.equal(other.texts.length, fresh.stats.chunks, 'every chunk embedded again with the new model')
  assert.ok(store.rows.every(r => r.embeddingModel === 'other|default'))
})

test('falls back to keyword search when the embedding endpoint fails', async () => {
  const { index } = setup()
  await indexAll(index)
  index.queryEmbedder = new FakeEmbedder({ fail: true })
  const res = await index.query('sem: gitea')
  assert.equal(res.fallback, true)
  assert.equal(res.mode, 'keyword')
  assert.deepEqual(res.results.map(r => r.pageId), [1])
})

test('indexing works and retries later when embeddings are unavailable', async () => {
  const failing = new FakeEmbedder({ fail: true })
  const { index } = setup({ embedder: failing, options: { retryBaseMs: 20 } })
  await indexAll(index)
  assert.equal(index.stats.embedded, 0)
  assert.deepEqual((await index.query('gitea')).results.map(r => r.pageId), [1], 'keyword results are available right away')
  failing.fail = false
  await new Promise(resolve => setTimeout(resolve, 60))
  await index.idle()
  assert.equal(index.stats.pending, 0)
  index.stop()
})

test('removePage and clear', async () => {
  const { index, store } = setup()
  await indexAll(index)
  await index.removePage(2)
  assert.equal(index.stats.pages, 3)
  assert.equal(store.rows.some(r => r.pageId === 2), false)
  await index.clear()
  assert.equal(index.stats.pages, 0)
  assert.equal(store.rows.length, 0)
})

test('stopwords in a query do not match every page', async () => {
  const { index } = setup()
  await indexAll(index, [
    page(1, 'a', 'A', '<p>Das ist eine Seite für Notizen.</p>'),
    page(2, 'b', 'B', '<p>Hier steht etwas für später.</p>'),
    page(3, 'c', 'C', '<p>Rezept für Brot.</p>')
  ])
  assert.deepEqual((await index.query('kw: Rezept für Kuchen')).results.map(r => r.pageId), [3])
})

test('relative cutoff drops pages that only share a common word', async () => {
  // "zugang" is on almost every page, "gitea" on one
  const pages = [
    page(1, 'gitea', 'Gitea', '<p>Zugang zu Gitea per SSH.</p>'),
    ...Array.from({ length: 12 }, (_, k) => page(k + 2, `p${k}`, `P${k}`, `<p>Zugang zu Dienst ${k}.</p>`))
  ]
  const strict = setup()
  await indexAll(strict.index, pages)
  assert.deepEqual((await strict.index.query('kw: gitea zugang')).results.map(r => r.pageId), [1])
  const loose = setup({ options: { keywordRelativeCutoff: 0 } })
  await indexAll(loose.index, pages)
  assert.equal((await loose.index.query('kw: gitea zugang')).results.length, 13)
})

test('empty or punctuation-only queries return nothing', async () => {
  const { index } = setup()
  await indexAll(index)
  assert.equal((await index.query('')).results.length, 0)
  assert.equal((await index.query('kw: ?!')).results.length, 0)
})
