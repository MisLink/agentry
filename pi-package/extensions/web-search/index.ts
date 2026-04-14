/**
 * Web Fetch Extension for pi
 *
 * Registers a `web_fetch` tool so the LLM can retrieve any URL and get
 * readable markdown back. No API key required. Fully local — no external
 * conversion services.
 *
 * Typical usage by the LLM:
 *   - Search: fetch https://html.duckduckgo.com/html/?q=your+query
 *   - Read a page: fetch https://example.com/some/page
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
import { execFile } from "node:child_process"
import { Type } from "@sinclair/typebox"
import { NodeHtmlMarkdown } from "node-html-markdown"

const DEFAULT_MAX_LENGTH = 12_000

// ── HTML → Markdown ───────────────────────────────────────────────────────

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
    // DuckDuckGo redirect
    const ddgMatch = href.match(/[?&]uddg=([^&]+)/)
    if (ddgMatch) return `[${text}](${decodeURIComponent(ddgMatch[1])})`

    // Protocol-relative
    if (href.startsWith("//")) {
      try {
        return `[${text}](${new URL(baseUrl).protocol}${href})`
      } catch {
        return `[${text}](https:${href})`
      }
    }

    // Relative URL
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

function htmlToMarkdown(html: string, baseUrl: string): string {
  const md = nhm.translate(html)
  return resolveDdgUrls(md, baseUrl)
}

// ── Binary content detection ──────────────────────────────────────────────

/** Content-Type prefixes that indicate binary/document content. */
const BINARY_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument", // .docx, .pptx, .xlsx
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/epub+zip",
  "application/zip",
  "application/vnd.ms-outlook",
]

/** URL extensions that markitdown handles better than HTML conversion. */
const BINARY_EXTENSIONS = /\.(pdf|docx|pptx|xlsx|epub|msg|ipynb)($|\?|#)/i

function isBinaryContent(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase()
  if (BINARY_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))) return true
  if (BINARY_EXTENSIONS.test(new URL(url).pathname)) return true
  return false
}

// ── markitdown fallback ───────────────────────────────────────────────────

/** Cache the resolved markitdown command so we only probe once. */
let resolvedMarkitdown: { cmd: string; args: string[] } | undefined

/**
 * Find the best way to run markitdown:
 * 1. `markitdown` on PATH (global install via mise/pipx/pip — instant)
 * 2. Fallback to `uv tool run --from 'markitdown[all]'` (cached after first run)
 */
function findMarkitdown(): Promise<{ cmd: string; args: string[] }> {
  if (resolvedMarkitdown) return Promise.resolve(resolvedMarkitdown)

  return new Promise((resolve) => {
    execFile("markitdown", ["--version"], { timeout: 5_000 }, (err) => {
      if (!err) {
        resolvedMarkitdown = { cmd: "markitdown", args: [] }
      } else {
        resolvedMarkitdown = {
          cmd: "uv",
          args: ["tool", "run", "--from", "markitdown[all]", "markitdown"],
        }
      }
      resolve(resolvedMarkitdown)
    })
  })
}

/**
 * Convert a URL to Markdown via markitdown.
 * Prefers a global install on PATH for speed; falls back to uv tool run.
 */
function runMarkitdown(url: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    findMarkitdown()
      .then(({ cmd, args }) => {
        const child = execFile(
          cmd,
          [...args, url],
          { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 },
          (err, stdout, stderr) => {
            if (err) {
              const msg = stderr?.trim() || err.message
              reject(new Error(`markitdown failed for ${url}: ${msg}`))
              return
            }
            resolve(stdout)
          }
        )
        signal?.addEventListener("abort", () => child.kill(), { once: true })
      })
      .catch(reject)
  })
}

// ── Fetch helper ──────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
}

/**
 * Fetch the URL directly, preferring `text/markdown` via content negotiation.
 * Sites like Cloudflare Docs honour the Accept header and return native Markdown.
 */
async function fetchDirect(
  url: string,
  signal?: AbortSignal
): Promise<{ text: string; contentType: string; status: number }> {
  const response = await fetch(url, {
    signal,
    headers: {
      ...BROWSER_HEADERS,
      Accept: "text/markdown, text/html, application/xhtml+xml, */*;q=0.8",
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  const raw = await response.text()
  return { text: raw, contentType, status: response.status }
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content as Markdown. " +
      "Automatically requests native Markdown from sites that support it " +
      "(e.g. Cloudflare Docs, many API documentation sites) via the " +
      "`Accept: text/markdown` header. " +
      "Use https://html.duckduckgo.com/html/?q=<query> to search the web.",
    promptSnippet:
      "Fetch any URL or search the web via DuckDuckGo; returns Markdown",
    promptGuidelines: [
      "Use web_fetch to search the web or read web pages when the user asks about current events, documentation, or anything that may require live information.",
      "To search: fetch https://html.duckduckgo.com/html/?q=your+search+query (URL-encode spaces as +).",
      "To read a page: fetch the URL directly. web_fetch automatically requests Markdown via content negotiation — documentation sites like Cloudflare Docs return clean native Markdown.",
      "Search results include [title](url) links — call web_fetch again on promising URLs to read the full content.",
      "Prefer targeted searches over broad ones; include relevant keywords to get better results.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description:
          "URL to fetch. For web search use https://html.duckduckgo.com/html/?q=your+query",
      }),
      maxLength: Type.Optional(
        Type.Number({
          description: `Maximum characters to return (default ${DEFAULT_MAX_LENGTH}).`,
          minimum: 1000,
          maximum: 50_000,
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { url, maxLength = DEFAULT_MAX_LENGTH } = params

      const result = await fetchDirect(url, signal ?? undefined)
      let text: string
      let converter = "raw"

      if (isBinaryContent(result.contentType, url)) {
        // Binary document — delegate to markitdown
        text = await runMarkitdown(url, signal ?? undefined)
        converter = "markitdown"
      } else if (
        result.contentType.includes("text/markdown") ||
        result.contentType.includes("text/plain")
      ) {
        // Native Markdown (or plain text) — use as-is
        text = result.text
        converter = "native"
      } else if (result.contentType.includes("text/html")) {
        // HTML — convert via node-html-markdown
        text = htmlToMarkdown(result.text, url)
        converter = "node-html-markdown"
      } else {
        // JSON, etc. — return raw
        text = result.text
      }

      const truncated = text.length > maxLength
      const output = truncated ? text.slice(0, maxLength) : text
      const suffix = truncated
        ? `\n\n[Content truncated at ${maxLength} chars — ${text.length} total. ` +
          `Call web_fetch again with a larger maxLength or fetch a specific section.]`
        : ""

      return {
        content: [{ type: "text", text: output + suffix }],
        details: {
          url,
          status: result.status,
          contentType: result.contentType,
          converter,
          length: text.length,
          truncated,
        },
      }
    },
  })
}
