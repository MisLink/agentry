/**
 * Web Fetch Extension for pi
 *
 * Registers `web_search` for lightweight DuckDuckGo search, `web_fetch`
 * for URL/content retrieval as readable markdown, and `get_search_content`
 * for retrieving stored full content from earlier search/fetch results.
 * No API key required. Fully local — no external conversion services.
 *
 * Typical usage by the LLM:
 *   - Search: `web_search({ query: "pi extension docs" })`
 *   - Read a page: `web_fetch({ url: "https://example.com/some/page" })`
 *
 * Migration note:
 *   - Legacy DuckDuckGo search URLs passed to `web_fetch` still work for
 *     backward compatibility with older prompts and resumed sessions.
 *
 * Content negotiation:
 *   - Sends `Accept: text/markdown` first; sites like Cloudflare Docs return
 *     native Markdown directly (no conversion needed).
 *   - Falls back to HTML→Markdown conversion via node-html-markdown for other
 *     sites. Supports tables, code blocks with language, GFM syntax.
 *
 * Binary content (PDF, DOCX, PPTX, XLSX, etc.):
 *   - Detected via Content-Type header or URL file extension.
 *   - Automatically converted to Markdown via `markitdown` (Python, invoked
 *     through `uv tool run`).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import {
  DEFAULT_MAX_LENGTH,
  fetchDirect,
  isBinaryContent,
  normalizeFetchTargets,
  runMarkitdown,
} from "./fetch"
import {
  htmlPageToMarkdown,
  htmlToMarkdown,
  shouldFallbackToMarkitdown,
} from "./html-extract"
import {
  DEFAULT_MAX_RESULTS,
  buildDuckDuckGoSearchUrl,
  extractDuckDuckGoResults,
  extractDuckDuckGoResultsFromHtml,
  formatDuckDuckGoResults,
  isDuckDuckGoSearchUrl,
  type DuckDuckGoSearchResult,
} from "./search"
import {
  getWebResponse,
  storeWebResponse,
  type StoredFetchContent,
  type StoredSearchQuery,
} from "./storage"
import { resolveGitHubFetchPlan } from "./github"

export {
  buildDuckDuckGoSearchUrl,
  extractDuckDuckGoResults,
  htmlPageToMarkdown,
  isDuckDuckGoSearchUrl,
}

function formatStoredSearchQuery(data: StoredSearchQuery): string {
  if (data.results.length === 0) {
    return `No stored search results found for "${data.query}".`
  }

  const lines = [`# Search results for "${data.query}"`, ""]

  for (const [index, result] of data.results.entries()) {
    lines.push(`${index + 1}. [${result.title}](${result.url})`)
    if (result.snippet) lines.push(`   ${result.snippet}`)
  }

  return lines.join("\n")
}

function formatStoredFetchContent(data: StoredFetchContent): string {
  return `# ${data.title}\n\n${data.content}`
}

function withResponseId(text: string, responseId: string): string {
  return `${text}\n\n[responseId: ${responseId}]`
}

function matchesDomainFilters(url: string, domainFilter: string[] | undefined): boolean {
  if (!domainFilter || domainFilter.length === 0) return true

  const includes = domainFilter
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && !value.startsWith("-"))
  const excludes = domainFilter
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.startsWith("-") && value.length > 1)
    .map((value) => value.slice(1))

  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }

  const matchesDomain = (domain: string): boolean => {
    return hostname === domain || hostname.endsWith(`.${domain}`)
  }

  if (excludes.some(matchesDomain)) return false
  if (includes.length === 0) return true
  return includes.some(matchesDomain)
}

function filterSearchResults(
  results: DuckDuckGoSearchResult[],
  domainFilter: string[] | undefined,
  maxResults: number
): DuckDuckGoSearchResult[] {
  const filtered = results.filter((result) => matchesDomainFilters(result.url, domainFilter))
  return filtered.slice(0, maxResults)
}

type FetchedUrlResult = {
  url: string
  title: string
  content: string
  status: number
  contentType: string
  converter: string
}

async function fetchResolvedUrlAsMarkdown(
  requestUrl: string,
  displayUrl: string,
  signal?: AbortSignal,
  forcedConverter?: string
): Promise<FetchedUrlResult> {
  const result = await fetchDirect(requestUrl, signal)
  let text: string
  let converter = forcedConverter ?? "raw"

  if (isBinaryContent(result.contentType, requestUrl)) {
    text = await runMarkitdown(requestUrl, signal)
    converter = forcedConverter ?? "markitdown"
  } else if (
    result.contentType.includes("text/markdown") ||
    result.contentType.includes("text/plain")
  ) {
    text = result.text
    converter = forcedConverter ?? "native"
  } else if (result.contentType.includes("text/html")) {
    if (isDuckDuckGoSearchUrl(displayUrl)) {
      text = htmlToMarkdown(result.text, displayUrl)
      converter = forcedConverter ?? "node-html-markdown-ddg-compat"
    } else {
      const htmlResult = htmlPageToMarkdown(result.text, displayUrl)
      text = htmlResult.text
      converter = forcedConverter ?? htmlResult.converter

      if (shouldFallbackToMarkitdown(text)) {
        try {
          text = await runMarkitdown(requestUrl, signal)
          converter = forcedConverter ?? "markitdown-fallback"
        } catch {
          // Keep HTML-derived markdown when markitdown fallback fails.
        }
      }
    }
  } else {
    text = result.text
  }

  return {
    url: displayUrl,
    title: displayUrl,
    content: text,
    status: result.status,
    contentType: result.contentType,
    converter,
  }
}

async function fetchUrlAsMarkdown(
  url: string,
  signal?: AbortSignal
): Promise<FetchedUrlResult> {
  const githubPlan = resolveGitHubFetchPlan(url)

  if (githubPlan.kind === "raw-file") {
    return fetchResolvedUrlAsMarkdown(githubPlan.rawUrl, url, signal, "github-raw-file")
  }

  if (githubPlan.kind === "repo-readme") {
    for (const readmeUrl of githubPlan.readmeUrls) {
      try {
        return await fetchResolvedUrlAsMarkdown(readmeUrl, url, signal, "github-readme")
      } catch {
        // Try next README candidate.
      }
    }
  }

  if (githubPlan.kind === "tree") {
    return {
      url,
      title: url,
      content: [
        `# GitHub directory ${githubPlan.owner}/${githubPlan.repo}`,
        "",
        `Path: ${githubPlan.path}`,
        `Open: ${githubPlan.treeUrl}`,
        "",
        "Directory pages are not cloned by this lightweight fetcher. Open specific blob links or repo README for direct content.",
      ].join("\n"),
      status: 200,
      contentType: "text/markdown",
      converter: "github-tree-summary",
    }
  }

  return fetchResolvedUrlAsMarkdown(url, url, signal)
}

function formatMultiFetchSummary(
  results: FetchedUrlResult[],
  failures: Array<{ url: string; error: string }>
): string {
  const lines = [`# Fetched ${results.length} URL(s)`, ""]

  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. [${result.title}](${result.url})`)
    lines.push(`   ${result.content.length} chars via ${result.converter}`)
  }

  if (failures.length > 0) {
    lines.push("", "## Failed URLs", "")
    for (const failure of failures) {
      lines.push(`- ${failure.url}: ${failure.error}`)
    }
  }

  lines.push("", "Use get_search_content with responseId to read stored full content.")
  return lines.join("\n")
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via DuckDuckGo and return relevant result links. " +
      "Use this to discover candidate URLs, then call web_fetch on promising results.",
    promptSnippet:
      "Search the web via DuckDuckGo; returns top result links as Markdown",
    promptGuidelines: [
      "Use web_search when the user asks you to search the web, find sources, or discover relevant pages before reading them.",
      "Pass plain query text to web_search instead of constructing a DuckDuckGo URL by hand.",
      "After web_search returns result links, call web_fetch on promising URLs to read full content.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query text.",
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}).`,
          minimum: 1,
          maximum: 10,
        })
      ),
      domainFilter: Type.Optional(
        Type.Array(
          Type.String({
            description: "Limit results to domains. Prefix with - to exclude a domain.",
          })
        )
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const query = params.query.trim()
      const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS
      const domainFilter = params.domainFilter
      const searchUrl = buildDuckDuckGoSearchUrl(query)
      const result = await fetchDirect(searchUrl, signal ?? undefined)
      const results = result.contentType.includes("text/html")
        ? extractDuckDuckGoResultsFromHtml(result.text, { maxResults, domainFilter })
        : filterSearchResults(extractDuckDuckGoResults(result.text, maxResults), domainFilter, maxResults)
      const output = formatDuckDuckGoResults(query, results)
      const responseId = storeWebResponse({
        type: "search",
        queries: [{ query, results }],
      })

      const details: Record<string, unknown> = {
        query,
        searchUrl,
        status: result.status,
        contentType: result.contentType,
        results,
        count: results.length,
        domainFilter,
        responseId,
      }

      return {
        content: [{ type: "text", text: withResponseId(output, responseId) }],
        details,
      }
    },
  })

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch one or more URLs and return content as Markdown. " +
      "Automatically requests native Markdown from sites that support it " +
      "(e.g. Cloudflare Docs, many API documentation sites) via the " +
      "`Accept: text/markdown` header.",
    promptSnippet:
      "Fetch one or more URLs and return page content as Markdown",
    promptGuidelines: [
      "Use web_fetch when you already have a specific URL and need to read its contents.",
      "For web search or source discovery, use web_search first instead of constructing search URLs by hand.",
      "web_fetch automatically requests Markdown via content negotiation — documentation sites like Cloudflare Docs often return clean native Markdown.",
      "If a fetched page contains promising links, call web_fetch again on the specific URL you want to inspect.",
      "Use a larger maxLength only when needed; otherwise keep responses small and targeted.",
    ],
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({
          description: "Single URL to fetch.",
        })
      ),
      urls: Type.Optional(
        Type.Array(
          Type.String({
            description: "Multiple URLs to fetch.",
          })
        )
      ),
      maxLength: Type.Optional(
        Type.Number({
          description: `Maximum characters to return (default ${DEFAULT_MAX_LENGTH}).`,
          minimum: 1000,
          maximum: 50_000,
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const maxLength = params.maxLength ?? DEFAULT_MAX_LENGTH
      const targets = normalizeFetchTargets({ url: params.url, urls: params.urls })

      const settled = await Promise.allSettled(
        targets.map((url) => fetchUrlAsMarkdown(url, signal ?? undefined))
      )
      const successes: FetchedUrlResult[] = []
      const failures: Array<{ url: string; error: string }> = []

      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "fulfilled") {
          successes.push(outcome.value)
          continue
        }

        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        failures.push({ url: targets[index], error: reason })
      }

      if (successes.length === 0) {
        const firstFailure = failures[0]
        throw new Error(firstFailure?.error ?? "Failed to fetch URL")
      }

      const responseId = storeWebResponse({
        type: "fetch",
        urls: successes.map((result) => ({
          url: result.url,
          title: result.title,
          content: result.content,
        })),
      })

      if (successes.length === 1 && failures.length === 0) {
        const [result] = successes
        const truncated = result.content.length > maxLength
        const output = truncated ? result.content.slice(0, maxLength) : result.content
        const suffix = truncated
          ? `\n\n[Content truncated at ${maxLength} chars — ${result.content.length} total. ` +
            `Call web_fetch again with a larger maxLength or fetch a specific section.]`
          : ""

        const details: Record<string, unknown> = {
          url: result.url,
          status: result.status,
          contentType: result.contentType,
          converter: result.converter,
          length: result.content.length,
          truncated,
          responseId,
        }

        return {
          content: [{ type: "text", text: withResponseId(output + suffix, responseId) }],
          details,
        }
      }

      const details: Record<string, unknown> = {
        urls: targets,
        fetchedCount: successes.length,
        failedCount: failures.length,
        failures,
        responseId,
      }

      return {
        content: [{
          type: "text",
          text: withResponseId(formatMultiFetchSummary(successes, failures), responseId),
        }],
        details,
      }
    },
  })

  pi.registerTool({
    name: "get_search_content",
    label: "Get Search Content",
    description:
      "Retrieve full content from a previous web_search or web_fetch call via responseId.",
    promptSnippet:
      "Use after web_search/web_fetch when stored full content is needed by responseId.",
    parameters: Type.Object({
      responseId: Type.String({
        description: "responseId returned from web_search or web_fetch.",
      }),
      query: Type.Optional(
        Type.String({
          description: "Query to retrieve from stored web_search results.",
        })
      ),
      queryIndex: Type.Optional(
        Type.Number({
          description: "Query index to retrieve from stored web_search results.",
          minimum: 0,
        })
      ),
      url: Type.Optional(
        Type.String({
          description: "URL to retrieve from stored web_fetch results.",
        })
      ),
      urlIndex: Type.Optional(
        Type.Number({
          description: "URL index to retrieve from stored web_fetch results.",
          minimum: 0,
        })
      ),
    }),

    async execute(_toolCallId, params) {
      const stored = getWebResponse(params.responseId)
      if (!stored) {
        const details: Record<string, unknown> = {
          responseId: params.responseId,
          error: "Not found",
        }

        return {
          content: [{ type: "text", text: `No stored response found for ${params.responseId}.` }],
          details,
        }
      }

      if (stored.type === "search") {
        let queryData: StoredSearchQuery | undefined

        if (typeof params.query === "string") {
          queryData = stored.queries.find((item) => item.query === params.query)
        } else if (typeof params.queryIndex === "number") {
          queryData = stored.queries[params.queryIndex]
        } else if (stored.queries.length === 1) {
          queryData = stored.queries[0]
        }

        if (!queryData) {
          const available = stored.queries.map((item, index) => `${index}: ${item.query}`).join("\n")
          const details: Record<string, unknown> = {
            responseId: params.responseId,
            error: "Missing or invalid query selector",
          }

          return {
            content: [{
              type: "text",
              text: `Stored search response requires query or queryIndex. Available queries:\n${available}`,
            }],
            details,
          }
        }

        const details: Record<string, unknown> = {
          responseId: params.responseId,
          type: stored.type,
          query: queryData.query,
          resultCount: queryData.results.length,
        }

        return {
          content: [{ type: "text", text: formatStoredSearchQuery(queryData) }],
          details,
        }
      }

      let urlData: StoredFetchContent | undefined
      if (typeof params.url === "string") {
        urlData = stored.urls.find((item) => item.url === params.url)
      } else if (typeof params.urlIndex === "number") {
        urlData = stored.urls[params.urlIndex]
      } else if (stored.urls.length === 1) {
        urlData = stored.urls[0]
      }

      if (!urlData) {
        const available = stored.urls.map((item, index) => `${index}: ${item.url}`).join("\n")
        const details: Record<string, unknown> = {
          responseId: params.responseId,
          error: "Missing or invalid url selector",
        }

        return {
          content: [{
            type: "text",
            text: `Stored fetch response requires url or urlIndex. Available URLs:\n${available}`,
          }],
          details,
        }
      }

      const details: Record<string, unknown> = {
        responseId: params.responseId,
        type: stored.type,
        url: urlData.url,
        title: urlData.title,
        length: urlData.content.length,
      }

      return {
        content: [{ type: "text", text: formatStoredFetchContent(urlData) }],
        details,
      }
    },
  })
}
