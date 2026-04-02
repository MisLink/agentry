/**
 * Web Fetch Extension for pi
 *
 * Registers a `web_fetch` tool so the LLM can retrieve any URL and get
 * readable text back. No API key required.
 *
 * Typical usage by the LLM:
 *   - Search: fetch https://html.duckduckgo.com/html/?q=your+query
 *   - Read a page: fetch https://example.com/some/page
 *
 * HTML is converted to plain text with links preserved as [title](url),
 * making it easy for the LLM to follow up on interesting results.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_MAX_LENGTH = 12_000;

// ── HTML → readable text ──────────────────────────────────────────────────

/**
 * DuckDuckGo wraps result links in redirect URLs like:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Factual-site.com&...
 * Decode these so the LLM sees the real destination.
 */
function resolveUrl(href: string, baseUrl: string): string {
  // DDG redirect
  const ddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (ddgMatch) return decodeURIComponent(ddgMatch[1]);

  // Protocol-relative  → use base protocol
  if (href.startsWith("//")) {
    try {
      return new URL(baseUrl).protocol + href;
    } catch {
      return "https:" + href;
    }
  }

  // Relative → resolve against base
  if (!href.startsWith("http")) {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  return href;
}

function htmlToText(html: string, baseUrl: string): string {
  return (
    html
      // Drop scripts, styles, nav noise
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      // Preserve links as [text](url) — the most useful thing for LLMs
      .replace(/<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
        const text = inner.replace(/<[^>]+>/g, "").trim();
        const url = resolveUrl(href, baseUrl);
        return text ? `[${text}](${url}) ` : "";
      })
      // Block elements → newlines
      .replace(/<\/?(p|div|h[1-6]|li|tr|br|section|article|main|aside|blockquote)[^>]*>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&[a-z]+;/gi, " ")
      // Collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content as readable text. " +
      "Use https://html.duckduckgo.com/html/?q=<query> to search the web without an API key. " +
      "HTML is converted to plain text; links are preserved as [title](url).",
    promptSnippet: "Fetch any URL or search the web via DuckDuckGo",
    promptGuidelines: [
      "Use web_fetch to search the web or read web pages when the user asks about current events, documentation, or anything that may require live information.",
      "To search: fetch https://html.duckduckgo.com/html/?q=your+search+query (URL-encode spaces as +).",
      "To read a page: fetch the URL directly.",
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
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { url, maxLength = DEFAULT_MAX_LENGTH } = params;

      const response = await fetch(url, {
        signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();

      let text: string;
      if (contentType.includes("text/html")) {
        text = htmlToText(raw, url);
      } else {
        // JSON, plain text, etc. — return as-is
        text = raw;
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
          status: response.status,
          contentType,
          length: text.length,
          truncated,
        },
      };
    },
  });
}
