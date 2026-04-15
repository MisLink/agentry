import { Readability } from "@mozilla/readability"
import { JSDOM } from "jsdom"
import { NodeHtmlMarkdown } from "node-html-markdown"

const nhm = new NodeHtmlMarkdown({
  ignore: ["nav", "footer", "header", "aside", "script", "style", "noscript"],
  keepDataImages: false,
})

/**
 * DuckDuckGo wraps result links in redirect URLs like:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Factual-site.com&...
 * Decode these so the LLM sees the real destination.
 */
function resolveDdgUrls(markdown: string, baseUrl: string): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => {
    const ddgMatch = href.match(/[?&]uddg=([^&]+)/)
    if (ddgMatch) return `[${text}](${decodeURIComponent(ddgMatch[1])})`

    if (href.startsWith("//")) {
      try {
        return `[${text}](${new URL(baseUrl).protocol}${href})`
      } catch {
        return `[${text}](https:${href})`
      }
    }

    if (
      !href.startsWith("http") &&
      !href.startsWith("#") &&
      !href.startsWith("mailto:")
    ) {
      try {
        return `[${text}](${new URL(href, baseUrl).href})`
      } catch {
        return `[${text}](${href})`
      }
    }

    return `[${text}](${href})`
  })
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  const md = nhm.translate(html)
  return resolveDdgUrls(md, baseUrl)
}

export type HtmlPageToMarkdownResult = {
  text: string
  converter: "readability+node-html-markdown" | "node-html-markdown"
}

const MARKITDOWN_FALLBACK_PATTERNS = [
  /accept cookies?/i,
  /privacy policy/i,
  /manage preferences/i,
  /sign in/i,
  /enable javascript/i,
  /cookie settings/i,
  /consent/i,
]

function shouldUseReadableContent(article: {
  content?: string | null
  textContent?: string | null
} | null): article is { content: string; textContent: string } {
  if (!article || typeof article.content !== "string" || typeof article.textContent !== "string") {
    return false
  }

  const text = article.textContent.replace(/\s+/g, " ").trim()
  if (text.length < 80) return false

  const paragraphCount = (article.content.match(/<p[\s>]/g) ?? []).length
  const headingCount = (article.content.match(/<h[1-6][\s>]/g) ?? []).length

  return (
    paragraphCount >= 2 ||
    (paragraphCount >= 1 && headingCount >= 1) ||
    text.length >= 200
  )
}

export function shouldFallbackToMarkitdown(markdown: string): boolean {
  const normalized = markdown.replace(/\s+/g, " ").trim()
  if (normalized.length === 0) return true
  if (normalized.length < 80) return true

  const suspiciousHits = MARKITDOWN_FALLBACK_PATTERNS.filter((pattern) =>
    pattern.test(markdown)
  ).length
  if (suspiciousHits === 0) return false

  return suspiciousHits >= 2 || normalized.length < 180
}

export function htmlPageToMarkdown(
  html: string,
  baseUrl: string
): HtmlPageToMarkdownResult {
  try {
    const dom = new JSDOM(html, { url: baseUrl })
    const article = new Readability(dom.window.document).parse()

    if (shouldUseReadableContent(article)) {
      return {
        text: htmlToMarkdown(article.content, baseUrl),
        converter: "readability+node-html-markdown",
      }
    }
  } catch {
    // Fall through to full-page conversion below.
  }

  return {
    text: htmlToMarkdown(html, baseUrl),
    converter: "node-html-markdown",
  }
}
