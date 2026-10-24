'use strict'

/** Scale a vector to unit length so that cosine similarity becomes a dot product. */
function normalizeVector (values) {
  const v = Float32Array.from(values)
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

function dot (a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** Store vectors as base64 of their float32 bytes: compact and portable across databases. */
function encodeVector (v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
}

function decodeVector (str) {
  if (!str) return null
  const buf = Buffer.from(str, 'base64')
  const copy = new Uint8Array(buf.length)
  copy.set(buf)
  return new Float32Array(copy.buffer, 0, Math.floor(buf.length / 4))
}

module.exports = { normalizeVector, dot, encodeVector, decodeVector }
