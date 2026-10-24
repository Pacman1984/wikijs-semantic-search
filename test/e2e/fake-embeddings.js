'use strict'

// Minimal OpenAI-compatible embeddings server for the e2e test.
// Uses the deterministic FakeEmbedder from the unit tests (bag of words with
// a few synonym groups), so semantic matches are predictable.

const http = require('http')
const { FakeEmbedder } = require('../unit/helpers')

const embedder = new FakeEmbedder({ dims: 128 })
let requests = 0

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', requests }))
  }
  if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
    res.writeHead(404)
    return res.end()
  }
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', async () => {
    requests++
    const { input, model } = JSON.parse(body)
    const texts = Array.isArray(input) ? input : [input]
    const vectors = await embedder.embed(texts)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      model,
      data: vectors.map((v, index) => ({ object: 'embedding', index, embedding: [...v] }))
    }))
  })
}).listen(8000, () => console.log('fake embeddings on :8000'))
