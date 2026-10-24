'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Bm25 } = require('../../module/lib/bm25')
const { parseQuery, bestPerPage, fuse } = require('../../module/lib/fusion')
const { normalizeVector, dot, encodeVector, decodeVector } = require('../../module/lib/vectors')

test('bm25 ranks the document with more matching terms first', () => {
  const idx = new Bm25()
  idx.add('a', ['ray', 'cluster', 'head', 'worker'])
  idx.add('b', ['mlflow', 'tracking', 'server'])
  idx.add('c', ['ray', 'jobs'])
  const scores = idx.search(['ray', 'cluster'])
  const order = [...scores].sort((x, y) => y[1] - x[1]).map(([id]) => id)
  assert.deepEqual(order, ['a', 'c'])
  assert.equal(scores.has('b'), false)
})

test('bm25 prefix expansion matches longer word forms with lower weight', () => {
  const idx = new Bm25()
  idx.add('exact', ['container'])
  idx.add('longer', ['containern'])
  const scores = idx.search(['container'])
  assert.ok(scores.get('exact') > scores.get('longer'))
  assert.ok(scores.get('longer') > 0)
  // short terms are not expanded
  idx.add('rx', ['raytracing'])
  assert.equal(idx.search(['ray']).size, 0)
})

test('bm25 remove keeps statistics consistent', () => {
  const idx = new Bm25()
  idx.add('a', ['x', 'y'])
  idx.add('b', ['y'])
  idx.remove('a')
  assert.equal(idx.size, 1)
  assert.equal(idx.totalLen, 1)
  assert.equal(idx.postings.has('x'), false)
  idx.add('b', ['z'])
  assert.equal(idx.size, 1)
  assert.equal(idx.search(['y']).size, 0)
})

test('parseQuery reads mode prefixes', () => {
  assert.deepEqual(parseQuery('kw: 10.10.0.133'), { mode: 'keyword', text: '10.10.0.133', explicit: true })
  assert.deepEqual(parseQuery('SEM:wie komme ich rein', 'keyword'), { mode: 'semantic', text: 'wie komme ich rein', explicit: true })
  assert.deepEqual(parseQuery('  gitea  ', 'semantic'), { mode: 'semantic', text: 'gitea', explicit: false })
  assert.equal(parseQuery('x', 'nonsense').mode, 'hybrid')
})

test('bestPerPage keeps the best chunk per page', () => {
  const scores = new Map([['1:0', 0.2], ['1:3', 0.9], ['2:1', 0.5]])
  assert.deepEqual(bestPerPage(scores, id => Number(id.split(':')[0])), [[1, 0.9], [2, 0.5]])
})

test('fuse combines both rankings with reciprocal rank fusion', () => {
  const kw = [[1, 9], [2, 5], [3, 1]]
  const sem = [[3, 0.9], [1, 0.8], [4, 0.7]]
  const fused = fuse(kw, sem).map(([id]) => id)
  assert.equal(fused[0], 1, 'page ranked high in both lists wins')
  assert.ok(fused.includes(4) && fused.includes(2))
  assert.deepEqual(fuse(kw, sem, { semanticWeight: 0 }).slice(0, 3).map(([id]) => id), [1, 2, 3])
})

test('vectors round-trip through base64 and normalize to unit length', () => {
  const v = normalizeVector([3, 4])
  assert.ok(Math.abs(dot(v, v) - 1) < 1e-6)
  const back = decodeVector(encodeVector(v))
  assert.deepEqual([...back], [...v])
  assert.equal(decodeVector(null), null)
})
