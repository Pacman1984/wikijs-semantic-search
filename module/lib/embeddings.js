'use strict'

const { normalizeVector } = require('./vectors')

/**
 * Client for any OpenAI-compatible `/v1/embeddings` endpoint
 * (llama.cpp server, Ollama, vLLM, LocalAI, OpenAI, …).
 */
class EmbeddingClient {
  /**
   * @param {object} opts
   * @param {string} opts.url        Base URL, e.g. http://localhost:11434/v1
   * @param {string} opts.model
   * @param {string} [opts.apiKey]
   * @param {number} [opts.dimensions]  Only sent when > 0
   * @param {number} [opts.timeoutMs]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor ({ url = '', model = '', apiKey = '', dimensions = 0, timeoutMs = 30000, fetchImpl } = {}) {
    this.url = String(url || '').trim().replace(/\/+$/, '')
    this.model = String(model || '').trim()
    this.apiKey = String(apiKey || '').trim()
    this.dimensions = Number(dimensions) || 0
    this.timeoutMs = Number(timeoutMs) || 30000
    this.fetch = fetchImpl || globalThis.fetch
  }

  get enabled () { return Boolean(this.url && this.model && this.fetch) }

  /** Identifies the vector space; stored embeddings from another space are recomputed. */
  get modelKey () { return `${this.model}|${this.dimensions || 'default'}` }

  /**
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]>} unit-length vectors, same order as `texts`
   */
  async embed (texts) {
    if (!this.enabled) throw new Error('embedding endpoint not configured')
    if (texts.length === 0) return []
    const body = { model: this.model, input: texts }
    if (this.dimensions > 0) body.dimensions = this.dimensions
    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const res = await this.fetch(`${this.url}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`embedding endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const json = await res.json()
    if (!json || !Array.isArray(json.data) || json.data.length !== texts.length) {
      throw new Error('embedding endpoint returned an unexpected response')
    }
    return [...json.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(d => normalizeVector(d.embedding))
  }
}

module.exports = { EmbeddingClient }
