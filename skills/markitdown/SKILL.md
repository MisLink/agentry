---
name: markitdown
description: >
  Convert files, documents, and URLs to LLM-friendly Markdown using markitdown.
  Trigger when the user asks to read, analyze, summarize, or extract content from:
  PDF, DOCX, PPTX, XLSX, EPUB, HTML files, images (OCR/EXIF), audio files,
  Jupyter notebooks (.ipynb), Outlook .msg, RSS feeds, CSV, ZIP archives,
  YouTube URLs, Wikipedia pages, or any URL where web_fetch gives poor results.
  Also trigger on: "读一下这个文档", "帮我看看这个 PDF", "总结这个文件",
  "convert to markdown", "extract text from", "summarize this document",
  "这个 PPT 讲了什么", "分析一下这个表格", "对比这两个文件",
  "这个网页转成 markdown 效果不好".
  Even for regular web pages, markitdown is available as a fallback when
  web_fetch output is noisy or incomplete — try markitdown if the first
  attempt at fetching a URL doesn't produce clean results.
---

# Markitdown — Universal Content-to-Markdown Converter

Convert documents, binary files, and URLs into LLM-friendly Markdown via
[markitdown](https://github.com/microsoft/markitdown) so you can read,
analyze, and summarize them.

## Supported Formats

| Format | Extensions / Sources |
|--------|---------------------|
| PDF | `.pdf` |
| Word | `.docx` |
| PowerPoint | `.pptx` |
| Excel | `.xlsx` |
| EPUB | `.epub` |
| HTML | `.html`, `.htm`, any URL |
| CSV | `.csv` |
| Images | `.jpg`, `.png`, `.gif`, `.webp`, `.tiff` (EXIF metadata) |
| Audio | `.mp3`, `.wav`, `.m4a` (metadata extraction) |
| Jupyter Notebook | `.ipynb` |
| Outlook Message | `.msg` |
| RSS | `.rss`, `.atom` feed URLs |
| ZIP archives | `.zip` (converts contained files recursively) |
| YouTube | YouTube video URLs (transcript extraction) |
| Wikipedia | Wikipedia article URLs |

## Usage

If `markitdown` is globally installed (e.g. via `mise`, `pipx`), use it directly.
Otherwise, use `uv tool run` as a fallback.

### Convert a local file

```bash
markitdown <path-to-file>
# or without global install:
uv tool run --from 'markitdown[all]' markitdown <path-to-file>
```

### Convert a URL (any URL — web pages, PDF links, YouTube, etc.)

```bash
markitdown <url>
```

markitdown fetches the URL itself and converts the content. This works for
regular web pages, PDF links, YouTube videos, RSS feeds, and more.

### Save output to a file

```bash
markitdown <path-or-url> -o /tmp/output.md
```

### Pipe from stdin (with format hint)

```bash
cat document.pdf | markitdown -x .pdf
```

## When to Use This vs web_fetch

Both tools can fetch URLs, but they have different strengths:

| Scenario | Recommended | Why |
|----------|-------------|-----|
| Quick web search (DuckDuckGo) | `web_fetch` | Built-in, instant |
| Regular web page (first attempt) | `web_fetch` | Faster, does content negotiation |
| Regular web page (web_fetch output was noisy) | `markitdown` | Different HTML parser, may produce cleaner results |
| **PDF, DOCX, PPTX, XLSX** (local or URL) | `markitdown` | web_fetch can't parse these (auto-falls back to markitdown for URLs) |
| YouTube video transcript | `markitdown` | Extracts transcript + metadata |
| RSS feed | `markitdown` | Native RSS support |
| Wikipedia article | Either | markitdown often gives cleaner output |
| Local file on disk | `markitdown` | web_fetch is URL-only |

**Decision flow:**
1. URL? Try `web_fetch` first (faster).
2. web_fetch output noisy or binary content? Use `markitdown`.
3. Local file? Use `markitdown` (only option).
4. YouTube / RSS / special source? Use `markitdown` directly.

## Caveats

- markitdown uses a plain Python `requests` User-Agent. Some sites (e.g.
  Wikipedia) return 403. For those, `web_fetch` works better (it sends
  browser-like headers).
- markitdown spawns a Python process via `uv`, so it's slower than
  `web_fetch` for simple HTML pages (~2-5s vs instant).

## Tips

- For large documents, save to a temp file first, then read relevant sections:
  ```bash
  markitdown report.pdf -o /tmp/report.md
  ```
  Then use `read` with `offset`/`limit` to inspect sections.

- The `[all]` extra includes all format support (PDF, DOCX, PPTX, XLSX,
  YouTube, audio, etc.). If globally installed via `mise`/`pipx` with
  `markitdown[all]`, all formats are available. With plain `uv tool run
  markitdown` (no extras), only basic formats work.

- The first `uv tool run` invocation may take a few seconds as `uv` resolves
  the environment. Subsequent calls reuse the cached environment and are fast.
  A global install avoids this overhead entirely.
