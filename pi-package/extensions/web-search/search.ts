import { JSDOM } from "jsdom"

export const DEFAULT_MAX_RESULTS = 5

export type DuckDuckGoSearchResult = {
  title: string
  url: string
  snippet?: string
}

export type ExtractDuckDuckGoResultsOptions = {
  maxResults: number
  domainFilter?: string[]
}

export function buildDuckDuckGoSearchUrl(query: string): string {
  const trimmed = query.trim()
  if (trimmed.length === 0) throw new Error("Search query must not be empty")
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed).replace(/%20/g, "+")}`
}

function isDuckDuckGoInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.endsWith("duckduckgo.com")
  } catch {
    return true
  }
}

function normalizeResultUrl(href: string, baseUrl: string): string | undefined {
  const trimmed = href.trim()
  if (trimmed.length === 0) return undefined

  const uddgMatch = trimmed.match(/[?&]uddg=([^&]+)/)
  if (uddgMatch) return decodeURIComponent(uddgMatch[1])

  try {
    if (trimmed.startsWith("//")) {
      return new URL(`${new URL(baseUrl).protocol}${trimmed}`).href
    }
    return new URL(trimmed, baseUrl).href
  } catch {
    return undefined
  }
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

export function isDuckDuckGoSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const isDuckDuckGoHost =
      parsed.hostname === "html.duckduckgo.com" || parsed.hostname === "duckduckgo.com"
    if (!isDuckDuckGoHost) return false

    const pathname = parsed.pathname.replace(/\/+$/, "")
    return pathname === "/html" && parsed.searchParams.get("q") !== null
  } catch {
    return false
  }
}

export function extractDuckDuckGoResults(
  markdown: string,
  maxResults: number
): DuckDuckGoSearchResult[] {
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error(`maxResults must be positive integer, got ${maxResults}`)
  }

  const results: DuckDuckGoSearchResult[] = []
  const seenUrls = new Set<string>()

  for (const match of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const title = match[1].replace(/\s+/g, " ").trim()
    const url = match[2].trim()

    if (title.length === 0 || url.length === 0) continue
    if (seenUrls.has(url)) continue
    if (isDuckDuckGoInternalUrl(url)) continue

    seenUrls.add(url)
    results.push({ title, url })

    if (results.length >= maxResults) break
  }

  return results
}

export function extractDuckDuckGoResultsFromHtml(
  html: string,
  options: ExtractDuckDuckGoResultsOptions
): DuckDuckGoSearchResult[] {
  const { maxResults, domainFilter } = options
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error(`maxResults must be positive integer, got ${maxResults}`)
  }

  const baseUrl = "https://html.duckduckgo.com/html/"
  const dom = new JSDOM(html, { url: baseUrl })
  const resultNodes = dom.window.document.querySelectorAll(".result")
  const results: DuckDuckGoSearchResult[] = []
  const seenUrls = new Set<string>()

  for (const node of resultNodes) {
    const titleNode = node.querySelector("a.result__a, h2 a, .result__title a")
    const rawHref = titleNode?.getAttribute("href")
    const url = rawHref ? normalizeResultUrl(rawHref, baseUrl) : undefined
    const title = titleNode?.textContent?.replace(/\s+/g, " ").trim() ?? ""
    const snippet =
      node
        .querySelector(".result__snippet, a.result__snippet")
        ?.textContent?.replace(/\s+/g, " ").trim() ?? ""

    if (title.length === 0 || !url) continue
    if (seenUrls.has(url)) continue
    if (isDuckDuckGoInternalUrl(url)) continue
    if (!matchesDomainFilters(url, domainFilter)) continue

    seenUrls.add(url)
    results.push({
      title,
      url,
      ...(snippet.length > 0 ? { snippet } : {}),
    })

    if (results.length >= maxResults) break
  }

  return results
}

export function formatDuckDuckGoResults(
  query: string,
  results: DuckDuckGoSearchResult[]
): string {
  if (results.length === 0) {
    return `No search results found for \"${query}\".`
  }

  const lines = [`# Search results for \"${query}\"`, ""]

  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. [${result.title}](${result.url})`)
    if (result.snippet) lines.push(`   ${result.snippet}`)
  }

  lines.push("", "Fetch any promising URL with web_fetch to read full page content.")
  return lines.join("\n")
}
