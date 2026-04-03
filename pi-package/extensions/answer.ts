/**
 * answer.ts — Extract and answer questions from the last assistant message.
 *
 * Addresses the gap that questionnaire.ts cannot fill: the AI has already
 * asked questions inside a prose response and the user wants to answer them
 * interactively, with free-text multi-line input per question.
 *
 * Flow:
 *   1. /answer (or Ctrl+.) — find the last assistant message on the branch
 *   2. BorderedLoader spinner while a lightweight LLM call extracts questions
 *      (prefers Claude Haiku for speed/cost; falls back to the current model)
 *   3. Custom Q&A TUI: one question at a time, Enter = next, Shift+Enter = newline
 *   4. pi.sendMessage({ triggerTurn: true }) sends compiled answers back
 *
 * Inspired by mitsuhiko/agent-stuff answer.ts, adapted to this project's
 * conventions: theme system instead of raw ANSI, BorderedLoader for the
 * extraction step, cleaner separation between extraction and display.
 */
import { complete, type UserMessage } from "@mariozechner/pi-ai"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import { BorderedLoader } from "@mariozechner/pi-coding-agent"
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@mariozechner/pi-tui"
import type { Theme } from "@mariozechner/pi-coding-agent"

// ─── Extraction ───────────────────────────────────────────────────────────────

interface ExtractedQuestion {
  question: string
  /** Optional context that helps answer the question. */
  context?: string
}

const EXTRACTION_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional: only include when context is essential for answering"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- If no questions are found, return {"questions": []}`

/** Prefer a fast, cheap model for extraction; fall back to the current model. */
async function selectExtractionModel(
  ctx: ExtensionContext
): Promise<typeof ctx.model> {
  if (!ctx.model) return ctx.model

  const haiku = ctx.modelRegistry.find("anthropic", "claude-haiku-4-5")
  if (haiku) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(haiku)
    if (auth.ok) return haiku
  }
  return ctx.model
}

function parseExtractedQuestions(text: string): ExtractedQuestion[] {
  try {
    let json = text
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) json = match[1].trim()
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed?.questions))
      return parsed.questions as ExtractedQuestion[]
  } catch {
    /* fall through */
  }
  return []
}

// ─── Q&A component ────────────────────────────────────────────────────────────

class QnAComponent implements Component, Focusable {
  private currentIndex = 0
  private readonly answers: string[]
  private readonly editor: Editor
  private cachedLines?: string[]
  private cachedWidth?: number

  // Focusable: propagate to Editor so the hardware cursor is positioned correctly.
  private _focused = false
  get focused(): boolean {
    return this._focused
  }
  set focused(value: boolean) {
    this._focused = value
    this.editor.focused = value
  }

  constructor(
    private readonly questions: ExtractedQuestion[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onDone: (result: string | null) => void
  ) {
    this.answers = questions.map(() => "")

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("dim", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    }
    this.editor = new Editor(tui, editorTheme)
    // disableSubmit = true: intercept Enter ourselves so we can distinguish
    // Enter (go to next question) from Shift+Enter (insert newline).
    this.editor.disableSubmit = true
    this.editor.onChange = () => this.invalidate()
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  private saveCurrentAnswer(): void {
    this.answers[this.currentIndex] = this.editor.getText()
  }

  private navigateTo(index: number): void {
    if (index < 0 || index >= this.questions.length) return
    this.saveCurrentAnswer()
    this.currentIndex = index
    this.editor.setText(this.answers[index] ?? "")
    this.invalidate()
  }

  private allAnswered(): boolean {
    this.saveCurrentAnswer()
    return this.answers.every((a) => a.trim().length > 0)
  }

  private submit(): void {
    this.saveCurrentAnswer()
    const parts = this.questions.flatMap((q, i) => {
      const answer = (this.answers[i] ?? "").trim() || "(no answer)"
      const lines = [`Q: ${q.question}`]
      if (q.context) lines.push(`> ${q.context}`)
      lines.push(`A: ${answer}`, "")
      return lines
    })
    this.onDone(parts.join("\n").trim())
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onDone(null)
      return
    }

    // Tab / Shift+Tab: navigate between questions.
    if (matchesKey(data, Key.tab)) {
      this.navigateTo(this.currentIndex + 1)
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.navigateTo(this.currentIndex - 1)
      this.tui.requestRender()
      return
    }

    // Enter (plain): advance to next question, or submit on the last one.
    // Shift+Enter: pass through to editor as a newline.
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.saveCurrentAnswer()
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1)
      } else {
        this.submit()
      }
      this.tui.requestRender()
      return
    }

    this.editor.handleInput(data)
    this.invalidate()
    this.tui.requestRender()
  }

  invalidate(): void {
    this.cachedLines = undefined
    this.cachedWidth = undefined
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

    const th = this.theme
    const innerWidth = Math.min(width - 4, 100)
    const contentWidth = innerWidth - 4
    const total = this.questions.length
    const current = this.currentIndex
    const q = this.questions[current]!

    const pad = (s: string): string => {
      const vis = visibleWidth(s)
      return s + " ".repeat(Math.max(0, innerWidth - vis - 1))
    }

    const boxLine = (content: string): string =>
      th.fg("borderMuted", "│") + " " + pad(content) + th.fg("borderMuted", "│")

    const divider = (): string =>
      th.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`)

    const lines: string[] = []
    const add = (s: string) => lines.push(truncateToWidth(s, width))

    // ── Header ────────────────────────────────────────────────────────────
    add(th.fg("borderMuted", `┌${"─".repeat(innerWidth)}┐`))
    const title =
      th.fg("accent", th.bold(" Answer questions ")) +
      th.fg("dim", `(${current + 1}/${total})`)
    add(boxLine(title))
    add(divider())

    // Progress dots: ● current (accent), ● answered (success), ○ unanswered (dim)
    const dots = this.questions.map((_, i) => {
      const answered = (this.answers[i] ?? "").trim().length > 0
      if (i === current) return th.fg("accent", "●")
      if (answered) return th.fg("success", "●")
      return th.fg("dim", "○")
    })
    add(boxLine(` ${dots.join(" ")}`))
    add(boxLine(""))

    // ── Question ──────────────────────────────────────────────────────────
    const questionLines = wrapTextWithAnsi(
      th.bold("Q: ") + th.fg("text", q.question),
      contentWidth
    )
    for (const line of questionLines) add(boxLine(line))

    // Context (if any)
    if (q.context) {
      add(boxLine(""))
      for (const line of wrapTextWithAnsi(
        th.fg("dim", `> ${q.context}`),
        contentWidth - 2
      )) {
        add(boxLine(`  ${line}`))
      }
    }
    add(boxLine(""))

    // ── Answer editor ─────────────────────────────────────────────────────
    add(boxLine(th.fg("muted", "A:")))
    const editorLines = this.editor.render(contentWidth - 4)
    // Skip the editor's own outer border lines (first and last).
    for (let i = 1; i < editorLines.length - 1; i++) {
      add(boxLine(`    ${editorLines[i]}`))
    }
    add(boxLine(""))

    // ── Footer ────────────────────────────────────────────────────────────
    add(divider())
    const isLast = current === total - 1
    const hint = isLast
      ? th.fg(
          "dim",
          " Enter submit · Shift+Enter newline · Tab prev · Esc cancel"
        )
      : th.fg(
          "dim",
          " Enter next · Shift+Enter newline · Tab/Shift+Tab nav · Esc cancel"
        )
    add(boxLine(hint))
    add(th.fg("borderMuted", `└${"─".repeat(innerWidth)}┘`))

    this.cachedLines = lines
    this.cachedWidth = width
    return lines
  }
}

// ─── Extension ────────────────────────────────────────────────────────────────

async function answerHandler(
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/answer requires interactive mode", "error")
    return
  }
  if (!ctx.model) {
    ctx.ui.notify("No model selected", "error")
    return
  }

  // Find the last assistant message on the current branch.
  let lastAssistantText: string | undefined
  for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
    const entry = ctx.sessionManager.getBranch()[i]
    if (entry.type !== "message") continue
    const msg = entry.message as {
      role?: string
      stopReason?: string
      content?: unknown
    }
    if (msg.role !== "assistant") continue
    if (msg.stopReason && msg.stopReason !== "stop") {
      ctx.ui.notify(
        `Last assistant message incomplete (${msg.stopReason})`,
        "error"
      )
      return
    }
    const parts = Array.isArray(msg.content) ? msg.content : []
    const text = parts
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n")
    if (text) {
      lastAssistantText = text
      break
    }
  }

  if (!lastAssistantText) {
    ctx.ui.notify("No assistant messages found on this branch", "error")
    return
  }

  // Step 1: extract questions with a fast LLM + spinner.
  const extractionModel = await selectExtractionModel(ctx)
  if (!extractionModel) {
    ctx.ui.notify("No model available for extraction", "error")
    return
  }

  const extracted = await ctx.ui.custom<ExtractedQuestion[] | null>(
    (tui, theme, _kb, done) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Extracting questions via ${extractionModel.id}…`
      )
      loader.onAbort = () => done(null)

      const doExtract = async () => {
        const auth =
          await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel)
        if (!auth.ok)
          throw new Error(auth.error)

        const userMessage: UserMessage = {
          role: "user",
          content: [{ type: "text", text: lastAssistantText! }],
          timestamp: Date.now(),
        }
        const response = await complete(
          extractionModel,
          { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
          { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal }
        )
        if (response.stopReason === "aborted") return null

        const responseText = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
        return parseExtractedQuestions(responseText)
      }

      doExtract()
        .then(done)
        .catch(() => done(null))

      return loader
    }
  )

  if (extracted === null) {
    ctx.ui.notify("Cancelled", "info")
    return
  }
  if (extracted.length === 0) {
    ctx.ui.notify("No questions found in the last assistant message", "info")
    return
  }

  // Step 2: show Q&A component.
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    return new QnAComponent(extracted, tui, theme, done)
  })

  if (result === null) {
    ctx.ui.notify("Cancelled", "info")
    return
  }

  // Step 3: inject answers and trigger a new LLM turn.
  pi.sendMessage(
    {
      customType: "answers",
      content: "I answered your questions:\n\n" + result,
      display: true,
    },
    { triggerTurn: true }
  )
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("answer", {
    description:
      "Extract questions from the last assistant message and answer them interactively",
    handler: (_args, ctx) => answerHandler(ctx, pi),
  })

  pi.registerShortcut("ctrl+.", {
    description: "Extract and answer questions from last assistant message",
    handler: (ctx) => answerHandler(ctx, pi),
  })
}
