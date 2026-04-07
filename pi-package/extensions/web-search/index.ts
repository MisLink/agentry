/**
 * Web Fetch Extension for pi
 *
 * Registers a `web_fetch` tool so the LLM can retrieve any URL and get
 * readable markdown back. No API key required.
 *
 * Typical usage by the LLM:
 *   - Search: fetch https://html.duckduckgo.com/html/?q=your+query
 *   - Read a page: fetch https://example.com/some/page
 *   - Force Jina markdown: fetch https://example.com/some/page with format="jina"
 *
 * Content negotiation:
 *   - Sends `Accept: text/markdown` first; sites like Cloudflare Docs return
 *     native Markdown directly (no conversion needed).
 *   - Falls back to HTML→Markdown conversion for other sites.
 *   - format="jina" routes through r.jina.ai for high-quality conversion of
 *     complex pages that don't support content negotiation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const DEFAULT_MAX_LENGTH = 12_000;

// ── URL resolution ────────────────────────────────────────────────────────

/**
 * DuckDuckGo wraps result links in redirect URLs like:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Factual-site.com&...
 * Decode these so the LLM sees the real destination.
 */
function resolveUrl(href: string, baseUrl: string): string {
  const ddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (ddgMatch) return decodeURIComponent(ddgMatch[1]);

  if (href.startsWith("//")) {
    try { return new URL(baseUrl).protocol + href; }
    catch { return "https:" + href; }
  }

  if (!href.startsWith("http")) {
    try { return new URL(href, baseUrl).href; }
    catch { return href; }
  }

  return href;
}

// ── HTML → Markdown ───────────────────────────────────────────────────────

/**
 * Convert HTML to Markdown, preserving semantic structure.
 * Handles headings, bold/italic, code, lists, blockquotes, and links.
 */
function htmlToMarkdown(html: string, baseUrl: string): string {
  return (
    html
      // ── Remove noise ──────────────────────────────────────────────────
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")

      // ── Headings → # syntax ───────────────────────────────────────────
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) =>
        `\n# ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) =>
        `\n## ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) =>
        `\n### ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) =>
        `\n#### ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, inner) =>
        `\n##### ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, inner) =>
        `\n###### ${inner.replace(/<[^>]+>/g, "").trim()}\n`)

      // ── Inline formatting ─────────────────────────────────────────────
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, inner) =>
        `**${inner.replace(/<[^>]+>/g, "").trim()}**`)
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, inner) =>
        `**${inner.replace(/<[^>]+>/g, "").trim()}**`)
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, inner) =>
        `_${inner.replace(/<[^>]+>/g, "").trim()}_`)
      .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, inner) =>
        `_${inner.replace(/<[^>]+>/g, "").trim()}_`)
      .replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, (_, inner) =>
        `~~${inner.replace(/<[^>]+>/g, "").trim()}~~`)

      // ── Code ──────────────────────────────────────────────────────────
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, inner) => {
        const code = inner
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
          .replace(/<[^>]+>/g, "");
        return `\n\`\`\`\n${code}\n\`\`\`\n`;
      })
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) =>
        `\`${inner.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")}\``)

      // ── Blockquotes ───────────────────────────────────────────────────
      .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
        const text = inner.replace(/<[^>]+>/g, "").trim();
        return "\n" + text.split("\n").map((l: string) => `> ${l}`).join("\n") + "\n";
      })

      // ── Lists ─────────────────────────────────────────────────────────
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) =>
        `\n- ${inner.replace(/<[^>]+>/g, "").trim()}`)
      .replace(/<\/[uo]l>/gi, "\n")

      // ── Links: preserve as [text](url) ────────────────────────────────
      .replace(/<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
        const text = inner.replace(/<[^>]+>/g, "").trim();
        const url = resolveUrl(href, baseUrl);
        return text ? `[${text}](${url})` : url;
      })

      // ── Block elements → newlines ─────────────────────────────────────
      .replace(/<\/?(p|div|tr|br|section|article|main|aside|hr)[^>]*>/gi, "\n")

      // ── Strip remaining tags ──────────────────────────────────────────
      .replace(/<[^>]+>/g, "")

      // ── HTML entities ─────────────────────────────────────────────────
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&[a-z]+;/gi, " ")

      // ── Normalise whitespace ──────────────────────────────────────────
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ── Fetch helpers ─────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
};

/**
 * Fetch via Jina Reader (r.jina.ai) for high-quality HTML→Markdown conversion.
 * Works for any public URL; no API key required for moderate usage.
 */
async function fetchViaJina(url: string, signal?: AbortSignal): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await fetch(jinaUrl, {
    signal,
    headers: {
      ...BROWSER_HEADERS,
      Accept: "text/plain, text/markdown, */*",
      "X-No-Cache": "true",         // always get fresh content
      "X-With-Links-Summary": "true", // include a links section at the end
    },
  });

  if (!response.ok) {
    throw new Error(`Jina Reader HTTP ${response.status} — ${jinaUrl}`);
  }

  return response.text();
}

/**
 * Fetch the URL directly, preferring `text/markdown` via content negotiation.
 * Sites like Cloudflare Docs honour the Accept header and return native Markdown.
 */
async function fetchDirect(
  url: string,
  signal?: AbortSignal,
): Promise<{ text: string; contentType: string; status: number }> {
  const response = await fetch(url, {
    signal,
    headers: {
      ...BROWSER_HEADERS,
      // Prefer markdown; fall back to HTML gracefully
      Accept: "text/markdown, text/html, application/xhtml+xml, */*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  return { text: raw, contentType, status: response.status };
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
      "Use format='jina' for complex HTML pages to get high-quality Markdown " +
      "via the Jina Reader service. " +
      "Use https://html.duckduckgo.com/html/?q=<query> to search the web.",
    promptSnippet:
      "Fetch any URL or search the web via DuckDuckGo; returns Markdown",
    promptGuidelines: [
      "Use web_fetch to search the web or read web pages when the user asks about current events, documentation, or anything that may require live information.",
      "To search: fetch https://html.duckduckgo.com/html/?q=your+search+query (URL-encode spaces as +).",
      "To read a page: fetch the URL directly. web_fetch automatically requests Markdown via content negotiation — documentation sites like Cloudflare Docs return clean native Markdown.",
      "Search results include [title](url) links — call web_fetch again on promising URLs to read the full content.",
      "For complex pages that return noisy HTML, use format='jina' to route through the Jina Reader service for higher-quality Markdown conversion.",
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
        }),
      ),
      format: Type.Optional(
        StringEnum(["auto", "jina"] as const, {
          description:
            "'auto' (default): request Markdown via content negotiation, fall back to HTML→Markdown conversion. " +
            "'jina': route through r.jina.ai for high-quality conversion of complex HTML pages.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { url, maxLength = DEFAULT_MAX_LENGTH, format = "auto" } = params;

      let text: string;
      let contentType = "text/markdown";
      let status = 200;

      if (format === "jina") {
        // ── Jina Reader path ─────────────────────────────────────────────
        text = await fetchViaJina(url, signal ?? undefined);
      } else {
        // ── Direct fetch with content negotiation ────────────────────────
        const result = await fetchDirect(url, signal ?? undefined);
        status = result.status;
        contentType = result.contentType;

        if (
          result.contentType.includes("text/markdown") ||
          result.contentType.includes("text/plain")
        ) {
          // Native Markdown (or plain text) — use as-is
          text = result.text;
        } else if (result.contentType.includes("text/html")) {
          // HTML — convert to Markdown
          text = htmlToMarkdown(result.text, url);
        } else {
          // JSON, binary, etc. — return raw
          text = result.text;
        }
      }

      const truncated = text.length > maxLength;
      const output = truncated ? text.slice(0, maxLength) : text;
      const suffix = truncated
        ? `\n\n[Content truncated at ${maxLength} chars — ${text.length} total. ` +
          `Call web_fetch again with a larger maxLength or fetch a specific section.]`
        : "";

      return {
        content: [{ type: "text", text: output + suffix }],
        details: {
          url,
          status,
          contentType,
          format,
          length: text.length,
          truncated,
        },
      };
    },
  });
}
