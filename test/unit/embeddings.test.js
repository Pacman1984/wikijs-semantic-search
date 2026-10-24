'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EmbeddingClient } = require('../../module/lib/embeddings')

function fakeFetch (handler) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return handler(url, init)
  }
  fn.calls = calls
  return fn
}

const ok = data => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => '' })

test('sends an OpenAI-compatible request and normalizes vectors in index order', async () => {
  const f = fakeFetch(() => ok([{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }]))
  const c = new EmbeddingClient({ url: 'http://host:1236/v1/', model: 'm', apiKey: 'secret', dimensions: 256, fetchImpl: f })
  const [a, b] = await c.embed(['x', 'y'])
  assert.equal(f.calls[0].url, 'http://host:1236/v1/embeddings')
  assert.deepEqual(f.calls[0].body, { model: 'm', input: ['x', 'y'], dimensions: 256 })
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer secret')
  assert.ok(Math.abs(a[0] - 0.6) < 1e-6 && Math.abs(a[1] - 0.8) < 1e-6)
  assert.deepEqual([...b], [0, 1])
})

test('omits optional fields when not configured', async () => {
  const f = fakeFetch(() => ok([{ index: 0, embedding: [1] }]))
  const c = new EmbeddingClient({ url: 'http://h/v1', model: 'm', fetchImpl: f })
  await c.embed(['x'])
  assert.deepEqual(f.calls[0].body, { model: 'm', input: ['x'] })
  assert.equal(f.calls[0].init.headers.authorization, undefined)
  assert.equal(c.modelKey, 'm|default')
})

test('is disabled without url or model and reports HTTP errors', async () => {
  assert.equal(new EmbeddingClient({ url: '', model: 'm' }).enabled, false)
  assert.equal(new EmbeddingClient({ url: 'http://h', model: '' }).enabled, false)
  const f = fakeFetch(() => ({ ok: false, status: 503, text: async () => 'busy' }))
  const c = new EmbeddingClient({ url: 'http://h', model: 'm', fetchImpl: f })
  await assert.rejects(c.embed(['x']), /HTTP 503: busy/)
  const bad = new EmbeddingClient({ url: 'http://h', model: 'm', fetchImpl: fakeFetch(() => ok([])) })
  await assert.rejects(bad.embed(['x']), /unexpected response/)
})
