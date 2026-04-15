import test from 'node:test'
import assert from 'node:assert/strict'

import * as searchMod from './search.ts'
import * as htmlMod from './html-extract.ts'
import * as fetchMod from './fetch.ts'

const {
  buildDuckDuckGoSearchUrl,
  extractDuckDuckGoResults,
  isDuckDuckGoSearchUrl,
} = searchMod

const { htmlPageToMarkdown } = htmlMod

async function importModuleOrFail(path) {
  try {
    return await import(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert.fail(`Unable to import ${path}: ${message}`)
  }
}

test('buildDuckDuckGoSearchUrl encodes query text', () => {
  assert.equal(
    buildDuckDuckGoSearchUrl('pi extension docs'),
    'https://html.duckduckgo.com/html/?q=pi+extension+docs'
  )
})

test('extractDuckDuckGoResults keeps unique result links', () => {
  const markdown = [
    '# Search results',
    '',
    '[Pi Extensions](https://pi.dev/extensions)',
    '[Pi Extensions](https://pi.dev/extensions)',
    '[Docs](https://docs.example.com/page)',
    '[Next Page](https://html.duckduckgo.com/html/?q=pi+extensions&s=30)',
    '[Fragment](#top)',
  ].join('\n')

  assert.deepEqual(extractDuckDuckGoResults(markdown, 5), [
    { title: 'Pi Extensions', url: 'https://pi.dev/extensions' },
    { title: 'Docs', url: 'https://docs.example.com/page' },
  ])
})

test('extractDuckDuckGoResults respects max result count', () => {
  const markdown = [
    '[One](https://example.com/1)',
    '[Two](https://example.com/2)',
    '[Three](https://example.com/3)',
  ].join('\n')

  assert.deepEqual(extractDuckDuckGoResults(markdown, 2), [
    { title: 'One', url: 'https://example.com/1' },
    { title: 'Two', url: 'https://example.com/2' },
  ])
})

test('extractDuckDuckGoResultsFromHtml returns snippets and honors domain filters', () => {
  assert.equal(typeof searchMod.extractDuckDuckGoResultsFromHtml, 'function')

  const html = `
    <html>
      <body>
        <div class="results">
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide">Pi Guide</a>
            <a class="result__snippet">Official guide for packaging and shipping Pi extensions.</a>
          </div>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.example.com%2Fpost">Blog Post</a>
            <a class="result__snippet">Personal notes about Pi extension workflow.</a>
          </div>
        </div>
      </body>
    </html>
  `

  const results = searchMod.extractDuckDuckGoResultsFromHtml(html, {
    maxResults: 5,
    domainFilter: ['docs.example.com', '-blog.example.com'],
  })

  assert.deepEqual(results, [
    {
      title: 'Pi Guide',
      url: 'https://docs.example.com/guide',
      snippet: 'Official guide for packaging and shipping Pi extensions.',
    },
  ])
})

test('isDuckDuckGoSearchUrl detects legacy DDG search URLs', () => {
  assert.equal(
    isDuckDuckGoSearchUrl('https://html.duckduckgo.com/html/?q=pi+extensions'),
    true
  )
  assert.equal(
    isDuckDuckGoSearchUrl(buildDuckDuckGoSearchUrl('pi extension docs')),
    true
  )
})

test('isDuckDuckGoSearchUrl ignores normal web pages', () => {
  assert.equal(isDuckDuckGoSearchUrl('https://duckduckgo.com/about'), false)
  assert.equal(isDuckDuckGoSearchUrl('https://example.com/search?q=pi'), false)
})

test('htmlPageToMarkdown prefers readable article content', () => {
  const html = `
    <html>
      <body>
        <header><nav>Docs Pricing Blog Sign in</nav></header>
        <div class="layout">
          <aside>Sidebar links API Guides Changelog</aside>
          <main>
            <article>
              <h1>Shipping Pi Extension Packages</h1>
              <p>Pi packages let you share tools, prompts, and skills with a single install command.</p>
              <p>Use project-local packages while iterating, then publish a git or npm package for reuse.</p>
            </article>
          </main>
        </div>
        <div class="cookie-banner">Accept all cookies</div>
        <footer>Copyright Example Inc.</footer>
      </body>
    </html>
  `

  const result = htmlPageToMarkdown(html, 'https://example.com/docs/pi-packages')

  assert.equal(result.converter, 'readability+node-html-markdown')
  assert.match(result.text, /# Shipping Pi Extension Packages/)
  assert.match(result.text, /Pi packages let you share tools/)
  assert.doesNotMatch(result.text, /Accept all cookies/)
  assert.doesNotMatch(result.text, /Docs Pricing Blog Sign in/)
  assert.doesNotMatch(result.text, /Sidebar links API Guides Changelog/)
})

test('htmlPageToMarkdown falls back for non-article pages', () => {
  const html = `
    <html>
      <body>
        <main>
          <ul>
            <li><a href="/one">Result One</a></li>
            <li><a href="/two">Result Two</a></li>
          </ul>
        </main>
      </body>
    </html>
  `

  const result = htmlPageToMarkdown(html, 'https://example.com/search')

  assert.equal(result.converter, 'node-html-markdown')
  assert.match(result.text, /\[Result One\]\(https:\/\/example\.com\/one\)/)
  assert.match(result.text, /\[Result Two\]\(https:\/\/example\.com\/two\)/)
})

test('shouldFallbackToMarkitdown flags cookie-wall style content only', () => {
  assert.equal(typeof htmlMod.shouldFallbackToMarkitdown, 'function')

  assert.equal(
    htmlMod.shouldFallbackToMarkitdown('Accept cookies\nSign in\nPrivacy policy\nManage preferences'),
    true
  )

  assert.equal(
    htmlMod.shouldFallbackToMarkitdown(
      '# Pi docs\n\nPi packages let you ship tools and prompts. This guide covers packaging, installation, and publishing in enough detail to be useful.'
    ),
    false
  )
})

test('normalizeFetchTargets supports single and multiple URLs', () => {
  assert.equal(typeof fetchMod.normalizeFetchTargets, 'function')

  assert.deepEqual(fetchMod.normalizeFetchTargets({ url: ' https://example.com/a ' }), [
    'https://example.com/a',
  ])

  assert.deepEqual(
    fetchMod.normalizeFetchTargets({
      urls: [' https://example.com/a ', 'https://example.com/b', 'https://example.com/a'],
    }),
    ['https://example.com/a', 'https://example.com/b']
  )

  assert.throws(() => fetchMod.normalizeFetchTargets({}), /No URL provided/)
})

test('storage keeps response data by responseId and clears cleanly', async () => {
  const storage = await importModuleOrFail('./storage.ts')

  assert.equal(typeof storage.clearWebSearchStorage, 'function')
  assert.equal(typeof storage.storeWebResponse, 'function')
  assert.equal(typeof storage.getWebResponse, 'function')

  storage.clearWebSearchStorage()

  const responseId = storage.storeWebResponse({
    type: 'fetch',
    urls: [
      {
        url: 'https://example.com/guide',
        title: 'Guide',
        content: 'Full page content',
      },
    ],
  })

  const stored = storage.getWebResponse(responseId)
  assert.equal(stored?.type, 'fetch')
  assert.equal(stored?.urls?.[0]?.content, 'Full page content')

  storage.clearWebSearchStorage()
  assert.equal(storage.getWebResponse(responseId), undefined)
})

test('resolveGitHubFetchPlan converts blob and repo URLs into lightweight fetch plans', async () => {
  const github = await importModuleOrFail('./github.ts')

  assert.equal(typeof github.resolveGitHubFetchPlan, 'function')

  assert.deepEqual(
    github.resolveGitHubFetchPlan('https://github.com/octo/demo/blob/main/src/index.ts'),
    {
      kind: 'raw-file',
      rawUrl: 'https://raw.githubusercontent.com/octo/demo/main/src/index.ts',
    }
  )

  assert.deepEqual(
    github.resolveGitHubFetchPlan('https://github.com/octo/demo'),
    {
      kind: 'repo-readme',
      owner: 'octo',
      repo: 'demo',
      readmeUrls: [
        'https://raw.githubusercontent.com/octo/demo/main/README.md',
        'https://raw.githubusercontent.com/octo/demo/master/README.md',
      ],
    }
  )

  assert.deepEqual(
    github.resolveGitHubFetchPlan('https://github.com/octo/demo/issues/1'),
    { kind: 'none' }
  )
})
