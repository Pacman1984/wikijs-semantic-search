'use strict'

/*
 * End-to-end test against a real Wiki.js 2.x instance (see compose.yml).
 * Sets up the wiki, creates pages, switches the search engine to
 * "semantic" and checks search through the GraphQL API, the same path the
 * web UI and MCP servers use.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const WIKI = process.env.WIKI_URL || 'http://wiki:3000'
const EMB = process.env.EMBEDDINGS_URL || 'http://embeddings:8000/v1'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let token = ''
let failures = 0

async function waitFor (label, fn, timeoutMs = 120000) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) { lastErr = err }
    await sleep(1000)
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`)
}

async function gql (query, variables = {}) {
  const res = await fetch(`${WIKI}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables })
  })
  const json = await res.json()
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '))
  return json.data
}

async function search (q, path) {
  const d = await gql('query($q:String!,$p:String){ pages { search(query:$q, path:$p) { results { id path title } totalHits } } }', { q, p: path })
  return d.pages.search.results.map(r => r.path)
}

async function createPage (path, title, content, extra = {}) {
  const d = await gql(`mutation($c:String!,$p:String!,$t:String!,$pub:Boolean!,$priv:Boolean!){
    pages { create(content:$c, description:"", editor:"markdown", isPublished:$pub, isPrivate:$priv, locale:"en", path:$p, tags:[], title:$t) {
      responseResult { succeeded message } page { id } } } }`,
  { c: content, p: path, t: title, pub: extra.isPublished !== false, priv: extra.isPrivate === true })
  assert.ok(d.pages.create.responseResult.succeeded, d.pages.create.responseResult.message)
  return d.pages.create.page.id
}

function engineConfig (cfg) {
  return Object.entries(cfg).map(([key, v]) => ({ key, value: JSON.stringify({ v }) }))
}

async function setEngine (key, cfg = {}) {
  const engines = [
    { key: 'db', isEnabled: key === 'db', config: [] },
    { key: 'semantic', isEnabled: key === 'semantic', config: engineConfig(cfg) }
  ]
  const d = await gql('mutation($e:[SearchEngineInput]){ search { updateSearchEngines(engines:$e) { responseResult { succeeded message } } } }', { e: engines })
  assert.ok(d.search.updateSearchEngines.responseResult.succeeded, d.search.updateSearchEngines.responseResult.message)
}

async function check (name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}

async function main () {
  console.log(`Wiki.js at ${WIKI}`)
  await waitFor('wiki setup page', async () => (await fetch(WIKI)).ok)

  // throwaway admin account, random password, only reachable inside the compose network
  const email = 'admin@example.test'
  const password = crypto.randomBytes(18).toString('base64url')
  const fin = await (await fetch(`${WIKI}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminEmail: email, adminPassword: password, adminPasswordConfirm: password, siteUrl: WIKI, telemetry: false })
  })).json()
  assert.ok(fin.ok, `setup failed: ${JSON.stringify(fin)}`)

  token = await waitFor('login after setup', async () => {
    const d = await gql('mutation($u:String!,$p:String!){ authentication { login(username:$u, password:$p, strategy:"local") { responseResult { succeeded } jwt } } }', { u: email, p: password })
    return d.authentication.login.responseResult.succeeded && d.authentication.login.jwt
  })
  const engines = await gql('{ search { searchEngines { key title isAvailable } } }')
  const semantic = engines.search.searchEngines.find(e => e.key === 'semantic')
  assert.ok(semantic, 'module is listed as a search engine')
  console.log(`Engine found: ${semantic.title}`)

  // pages created while the built-in engine is still active
  const gitea = await createPage('homelab/gitea', 'Gitea', '# Gitea\n\nGit-Server auf LXC 200, IP 10.10.0.123.\n\n## Zugang\n\nSSH als Benutzer gitea.')
  await createPage('homelab/seaweedfs', 'SeaweedFS', '# SeaweedFS\n\nS3-Speicher. Es gibt keine Sicherung der Daten.')
  await createPage('projects/tennis/overview', 'Tennis', 'Wettmodell mit Ray-Cluster und MLflow-Tracking.')
  await createPage('private/tagebuch', 'Tagebuch', 'Geheimer Eintrag über Gitea.')
  await createPage('drafts/entwurf', 'Entwurf', 'Unveröffentlicht: Gitea Notiz.', { isPublished: false })

  await setEngine('semantic', {
    mode: 'hybrid',
    embeddingUrl: EMB,
    embeddingModel: 'fake',
    queryInstruction: '',
    semanticMinScore: 0.2,
    excludePaths: 'private/'
  })

  await waitFor('semantic results after activation', async () => (await search('sem: backup'))[0] === 'homelab/seaweedfs', 60000)

  await check('activation indexes existing pages, keyword search reads page content', async () => {
    assert.deepEqual(await search('kw: ray cluster'), ['projects/tennis/overview'])
    assert.deepEqual(await search('kw: 10.10.0.123'), ['homelab/gitea'])
  })
  await check('semantic search finds a synonym missing from the page', async () => {
    assert.equal((await search('kw: backup')).length, 0)
    assert.equal((await search('sem: backup'))[0], 'homelab/seaweedfs')
  })
  await check('hybrid is the default and ranks the obvious page first', async () => {
    assert.equal((await search('gitea zugang'))[0], 'homelab/gitea')
  })
  await check('excluded and unpublished pages are not returned', async () => {
    const r = await search('kw: gitea')
    assert.ok(!r.includes('private/tagebuch'), 'private/ excluded')
    assert.ok(!r.includes('drafts/entwurf'), 'unpublished excluded')
  })
  await check('path filter', async () => {
    assert.deepEqual(await search('kw: mlflow', 'homelab/'), [])
    assert.deepEqual(await search('kw: mlflow', 'projects/'), ['projects/tennis/overview'])
  })
  await check('new pages are indexed through the create hook', async () => {
    await createPage('homelab/mlflow', 'MLflow', 'Tracking-Server auf Port 5000 mit Artefakt-Proxy.')
    assert.deepEqual(await search('kw: artefakt-proxy'), ['homelab/mlflow'])
  })
  await check('updates replace old content in the index', async () => {
    const d = await gql('mutation($id:Int!,$c:String!){ pages { update(id:$id, content:$c, tags:[], isPublished:true, isPrivate:false) { responseResult { succeeded message } } } }',
      { id: gitea, c: '# Gitea\n\nForgejo-kompatibler Git-Dienst, jetzt auf LXC 300.' })
    assert.ok(d.pages.update.responseResult.succeeded, d.pages.update.responseResult.message)
    assert.deepEqual(await search('kw: forgejo'), ['homelab/gitea'])
    assert.deepEqual(await search('kw: 10.10.0.123'), [])
  })
  await check('moving a page updates its path in results', async () => {
    const d = await gql('mutation($id:Int!){ pages { move(id:$id, destinationPath:"homelab/git/gitea", destinationLocale:"en") { responseResult { succeeded message } } } }', { id: gitea })
    assert.ok(d.pages.move.responseResult.succeeded, d.pages.move.responseResult.message)
    assert.deepEqual(await search('kw: forgejo'), ['homelab/git/gitea'])
  })
  await check('deleted pages disappear', async () => {
    const d = await gql('mutation($id:Int!){ pages { delete(id:$id) { responseResult { succeeded message } } } }', { id: gitea })
    assert.ok(d.pages.delete.responseResult.succeeded)
    assert.deepEqual(await search('kw: forgejo'), [])
  })
  await check('rebuild index from the admin area', async () => {
    const d = await gql('mutation { search { rebuildIndex { responseResult { succeeded message } } } }')
    assert.ok(d.search.rebuildIndex.responseResult.succeeded, d.search.rebuildIndex.responseResult.message)
    assert.deepEqual(await search('kw: ray cluster'), ['projects/tennis/overview'])
    await waitFor('embeddings after rebuild', async () => (await search('sem: backup'))[0] === 'homelab/seaweedfs', 30000)
  })
  await check('saving the settings again does not re-embed unchanged pages', async () => {
    const requests = async () => (await (await fetch(EMB.replace(/\/v1$/, '/health'))).json()).requests
    const before = await requests()
    await setEngine('semantic', { mode: 'keyword', embeddingUrl: EMB, embeddingModel: 'fake', queryInstruction: '', semanticMinScore: 0.2, excludePaths: 'private/' })
    await sleep(3000) // let the background reconcile run
    assert.equal(await requests(), before, 'no embedding requests after a settings change')
    assert.deepEqual(await search('backup'), [], 'default mode keyword now applies')
    assert.equal((await search('sem: backup'))[0], 'homelab/seaweedfs', 'stored embeddings still usable')
    await setEngine('semantic', { mode: 'hybrid', embeddingUrl: EMB, embeddingModel: 'fake', queryInstruction: '', semanticMinScore: 0.2, excludePaths: 'private/' })
  })
  await check('falls back to keyword search when the embedding endpoint is down', async () => {
    await setEngine('semantic', { mode: 'hybrid', embeddingUrl: 'http://embeddings:9/v1', embeddingModel: 'fake', queryInstruction: '', semanticMinScore: 0.2, excludePaths: 'private/' })
    const keyword = await search('kw: mlflow')
    assert.ok(keyword.includes('homelab/mlflow'))
    assert.deepEqual(await search('sem: mlflow'), keyword, 'semantic query degrades to keyword results')
    assert.deepEqual(await search('mlflow'), keyword, 'hybrid query degrades to keyword results')
  })
  await check('switching back to the built-in engine still works', async () => {
    await setEngine('db')
    assert.ok((await search('MLflow')).includes('homelab/mlflow'))
  })

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
