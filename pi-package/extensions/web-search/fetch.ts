import { execFile } from "node:child_process"

export const DEFAULT_MAX_LENGTH = 12_000

export type FetchDirectResult = {
  text: string
  contentType: string
  status: number
}

export type FetchTargetsInput = {
  url?: string
  urls?: string[]
}

/** Content-Type prefixes that indicate binary/document content. */
const BINARY_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/epub+zip",
  "application/zip",
  "application/vnd.ms-outlook",
]

/** URL extensions that markitdown handles better than HTML conversion. */
const BINARY_EXTENSIONS = /\.(pdf|docx|pptx|xlsx|epub|msg|ipynb)($|\?|#)/i

export function normalizeFetchTargets(input: FetchTargetsInput): string[] {
  const rawTargets = [
    ...(typeof input.url === "string" ? [input.url] : []),
    ...(Array.isArray(input.urls) ? input.urls : []),
  ]

  const normalized: string[] = []
  const seen = new Set<string>()

  for (const target of rawTargets) {
    const trimmed = target.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }

  if (normalized.length === 0) {
    throw new Error("No URL provided")
  }

  return normalized
}

export function isBinaryContent(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase()
  if (BINARY_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))) return true
  if (BINARY_EXTENSIONS.test(new URL(url).pathname)) return true
  return false
}

let resolvedMarkitdown: { cmd: string; args: string[] } | undefined

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

export function runMarkitdown(url: string, signal?: AbortSignal): Promise<string> {
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

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
}

export async function fetchDirect(
  url: string,
  signal?: AbortSignal
): Promise<FetchDirectResult> {
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
