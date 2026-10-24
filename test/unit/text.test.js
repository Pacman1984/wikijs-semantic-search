'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { htmlToSections, chunkSections, tokenize, decodeEntities, htmlToText } = require('../../module/lib/text')

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#228; &#x00fc; &uuml; &unknown;'), 'a & b <c> ä ü ü &unknown;')
})

test('htmlToText keeps block boundaries and drops toc anchors', () => {
  const html = '<p>Erste Zeile<br>zweite</p><ul><li>eins</li><li>zwei</li></ul><h2 id="x"><a class="toc-anchor" href="#x">¶</a> Titel</h2>'
  assert.equal(htmlToText(html), 'Erste Zeile\nzweite\neins\nzwei\nTitel')
})

test('htmlToSections splits at headings, keeps intro text', () => {
  const html = '<p>Intro</p><h1>Gitea</h1><p>Git-Server auf LXC 200.</p><h2>Zugang</h2><p>SSH als <code>gitea</code>.</p>'
  assert.deepEqual(htmlToSections(html), [
    { heading: '', text: 'Intro' },
    { heading: 'Gitea', text: 'Git-Server auf LXC 200.' },
    { heading: 'Zugang', text: 'SSH als gitea .' }
  ])
})

test('htmlToSections drops script and style content', () => {
  assert.deepEqual(htmlToSections('<style>.a{}</style><p>x y</p><script>alert(1)</script>'), [{ heading: '', text: 'x y' }])
})

test('chunkSections keeps paragraphs together up to the size limit', () => {
  const text = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n')
  const chunks = chunkSections([{ heading: 'H', text }], { size: 90, overlap: 10 })
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].text, `${'a'.repeat(40)}\n${'b'.repeat(40)}`)
  assert.equal(chunks[1].heading, 'H')
})

test('chunkSections splits over-long paragraphs with overlap', () => {
  const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')
  const chunks = chunkSections([{ heading: '', text: words }], { size: 100, overlap: 20 })
  assert.ok(chunks.length > 3)
  assert.ok(chunks.every(c => c.text.length <= 100))
  const firstEnd = chunks[0].text.split(' ').pop()
  assert.ok(chunks[1].text.includes(firstEnd), 'overlap repeats the end of the previous chunk')
})

test('queryTokens drops stopwords unless nothing else is left', () => {
  const { queryTokens } = require('../../module/lib/text')
  assert.deepEqual(queryTokens('Rezept für Apfelkuchen'), ['rezept', 'apfelkuchen'])
  assert.deepEqual(queryTokens('wie komme ich an die Zugangsdaten'), ['komme', 'zugangsdaten'])
  assert.deepEqual(queryTokens('the who'), ['the', 'who'])
})

test('tokenize lowercases, strips accents and splits compounds', () => {
  assert.deepEqual(tokenize('Übersicht Ray-Cluster'), ['ubersicht', 'ray-cluster', 'ray', 'cluster'])
  assert.deepEqual(tokenize('IP 10.10.0.133'), ['ip', '10.10.0.133', '10', '10', '0', '133'])
  assert.deepEqual(tokenize('a b 7 /opt/wikijs'), ['7', 'opt/wikijs', 'opt', 'wikijs'])
})
