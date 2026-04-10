/**
 * Error formatting — widget lines, LLM message, and status-bar text.
 *
 * Covers Step 7 (auto-fix / notify-only mode text) and
 * Step 8 (widget layout + smart truncation).
 */

import type { CheckerConfig, Diagnostic } from "./types.js";

export interface FormatResult {
  /** One-line status bar text (no ANSI — caller applies theme). */
  statusText: string;
  /** Widget lines for setWidget() — includes ANSI via theme. */
  widgetLines: string[];
  /** Full message injected into LLM context. */
  llmMessage: string;
}

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

// ── Public helpers ─────────────────────────────────────────────────────────

/**
 * Build the full display package for a set of NEW errors from one checker.
 *
 * @param checkerName  Display name, e.g. "TypeScript"
 * @param projectRoot  Absolute project root (used for display trimming only)
 * @param newErrors    Delta errors — already filtered against baseline
 * @param config       Current extension config
 * @param isLooping    Whether loop detection fired for this project
 * @param theme        TUI theme for ANSI coloring
 */
export function formatCheckResult(
  checkerName: string,
  newErrors: Diagnostic[],
  config: CheckerConfig,
  isLooping: boolean,
  theme: Theme,
): FormatResult {
  const total = newErrors.length;
  const cap = config.maxErrors;
  const shown = Math.min(total, cap);
  const capped = newErrors.slice(0, shown);

  // ── Group errors by file ────────────────────────────────────────────────
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of capped) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file)!.push(d);
  }

  // ── Widget lines (TUI) ─────────────────────────────────────────────────
  const widgetLines: string[] = [];
  widgetLines.push(
    theme.fg("error", `  ✗ ${checkerName}: ${total} new error${total !== 1 ? "s" : ""}`),
  );

  for (const [file, diags] of byFile) {
    widgetLines.push(theme.fg("warning", `    ${file}`));
    // Show at most 3 lines per file in the widget to keep it compact.
    const preview = diags.slice(0, 3);
    for (const d of preview) {
      const msg = d.message.length > 55 ? d.message.slice(0, 52) + "…" : d.message;
      widgetLines.push(theme.fg("dim", `      ${d.line}:${d.col}  ${msg}`));
    }
    if (diags.length > 3) {
      widgetLines.push(theme.fg("dim", `      … ${diags.length - 3} more in this file`));
    }
  }

  if (total > cap) {
    widgetLines.push(theme.fg("dim", `  … and ${total - cap} more errors (cap: ${cap})`));
  }

  if (isLooping) {
    widgetLines.push(
      theme.fg("warning", "  ⚠ Same errors for several turns — try a different approach"),
    );
  }

  // ── LLM message ────────────────────────────────────────────────────────
  let llmMessage = buildLlmMessage(checkerName, total, cap, byFile, isLooping);

  // ── Status bar (no ANSI) ───────────────────────────────────────────────
  const statusText = `✗ ${checkerName}: ${total}`;

  return { statusText, widgetLines, llmMessage };
}

// ── Internal ───────────────────────────────────────────────────────────────

function buildLlmMessage(
  checkerName: string,
  total: number,
  cap: number,
  byFile: Map<string, Diagnostic[]>,
  isLooping: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    `⚠️ **${checkerName}** found ${total} new error${total !== 1 ? "s" : ""}` +
      (total > cap ? ` (showing first ${cap})` : "") +
      ":",
  );
  lines.push("");
  lines.push("```");

  for (const [file, diags] of byFile) {
    for (const d of diags) {
      lines.push(`${file}:${d.line}:${d.col}: ${d.severity}: ${d.message}`);
    }
  }

  lines.push("```");

  if (total > cap) {
    lines.push("");
    lines.push(
      `> Fix the ${cap} errors above first. ${total - cap} additional error${total - cap !== 1 ? "s" : ""} will appear afterwards.`,
    );
  }

  if (isLooping) {
    lines.push("");
    lines.push(
      "⚠️ **Loop detected**: these same errors have persisted for several consecutive turns.",
      "Consider stepping back and trying a fundamentally different approach.",
    );
  }

  return lines.join("\n");
}

// ── Aggregate widget helpers ───────────────────────────────────────────────

/**
 * Merge multiple per-checker widget line blocks into one combined widget.
 * Returns undefined when there are no errors (caller should hide widget).
 */
export function buildCombinedWidget(
  blocks: Array<{ widgetLines: string[]; hasErrors: boolean }>,
  theme: Theme,
): string[] | undefined {
  const active = blocks.filter((b) => b.hasErrors);
  if (active.length === 0) return undefined;

  const lines: string[] = [theme.fg("muted", "  Static Check")];
  for (const block of active) {
    lines.push(...block.widgetLines);
  }
  return lines;
}
