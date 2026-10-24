'use strict'

const TABLE = 'semanticSearchChunks'
const INSERT_BATCH = 50

/**
 * Persists chunks in the Wiki.js database through its knex instance, so the
 * module works on every database Wiki.js supports (SQLite, PostgreSQL,
 * MySQL/MariaDB, MS SQL) without extensions.
 */
class KnexStore {
  constructor (knex, table = TABLE) {
    this.knex = knex
    this.table = table
  }

  async ensureTable () {
    if (await this.knex.schema.hasTable(this.table)) return
    await this.knex.schema.createTable(this.table, t => {
      t.increments('id').primary()
      t.integer('pageId').notNullable().index()
      t.integer('chunkIndex').notNullable()
      t.string('locale', 20).notNullable()
      t.text('path').notNullable()
      t.text('heading')
      t.text('body')
      t.string('hash', 64).notNullable()
      t.text('embedding')
      t.string('embeddingModel', 255)
    })
  }

  async dropTable () {
    await this.knex.schema.dropTableIfExists(this.table)
  }

  loadAll () {
    return this.knex(this.table).select('pageId', 'chunkIndex', 'locale', 'path', 'heading', 'body', 'hash', 'embedding', 'embeddingModel')
  }

  async replacePage (pageId, rows) {
    await this.knex.transaction(async trx => {
      await trx(this.table).where({ pageId }).del()
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await trx(this.table).insert(rows.slice(i, i + INSERT_BATCH))
      }
    })
  }

  deletePage (pageId) {
    return this.knex(this.table).where({ pageId }).del()
  }

  updateEmbedding ({ pageId, chunkIndex, hash, embedding, embeddingModel }) {
    return this.knex(this.table).where({ pageId, chunkIndex, hash }).update({ embedding, embeddingModel })
  }

  clear () {
    return this.knex(this.table).del()
  }
}

module.exports = { KnexStore, TABLE }
