/**
 * Core types for the multi-language static checker extension.
 *
 * Adding a new language = implementing LanguageChecker and registering it
 * in checkers/index.ts. Zero changes to the main extension logic.
 */

// ── Diagnostics ────────────────────────────────────────────────────────────

/** A single type / lint error reported by a checker. */
export interface Diagnostic {
  /** Path relative to projectRoot (forward slashes). */
  file: string;
  line: number;
  col: number;
  message: string;
  severity: "error" | "warning";
  /**
   * Stable identity string used for baseline diffing and loop detection.
   * Format: "file:line:col:message"
   */
  readonly fingerprint: string;
}

export function makeDiagnostic(
  file: string,
  line: number,
  col: number,
  message: string,
  severity: "error" | "warning" = "error",
): Diagnostic {
  return {
    file,
    line,
    col,
    message,
    severity,
    fingerprint: `${file}:${line}:${col}:${message}`,
  };
}

// ── Tool discovery ─────────────────────────────────────────────────────────

/**
 * A concrete tool executable discovered for a project.
 * Produced by LanguageChecker.detectTool(), consumed by LanguageChecker.buildArgs().
 */
export interface ToolSpec {
  /** The executable to invoke (absolute path or bare name on PATH). */
  cmd: string;
  /**
   * Logical tool id, e.g. "tsc", "mypy", "pyright".
   * Checkers use this in buildArgs() to select the right flags,
   * independent of cmd path.
   */
  toolId: string;
  /** Discovery tier — used for status display and debug logging. */
  tier: "local" | "system" | "runner";
  /** Human-readable label, e.g. "tsc (local)", "mypy (venv)", "mypy (uvx)". */
  displayName: string;
}

// ── Language checker plugin ────────────────────────────────────────────────

/**
 * Plugin interface for a language-specific static checker.
 *
 * Implement this interface and add the instance to checkers/index.ts
 * to support a new language. No other files need to change.
 */
export interface LanguageChecker {
  /** Unique id, e.g. "typescript", "python", "go", "rust". */
  id: string;
  /** Display name shown in UI, e.g. "TypeScript". */
  name: string;
  /**
   * File extensions this checker handles (lowercase, including dot).
   * e.g. [".ts", ".tsx"]
   */
  extensions: string[];
  /**
   * Filenames that mark the project root directory.
   * The project-finder walks up from the edited file until it finds a
   * directory containing one of these files.
   * e.g. ["tsconfig.json"] for TypeScript
   */
  configFiles: string[];
  /**
   * Detect the best available tool for this project.
   *
   * Detection order (implemented per-checker using tool-finder helpers):
   *   1. Project-local  (node_modules/.bin, .venv/bin, etc.)
   *   2. System PATH    (bare command name)
   *   3. Package runner (npx, uvx, etc.)
   *
   * Return null when no suitable tool is found anywhere.
   * Returning null causes the check for this language to be silently skipped
   * (a one-time notification is shown to the user).
   */
  detectTool(projectRoot: string): Promise<ToolSpec | null>;
  /**
   * Build the argv to pass when executing the tool.
   * Does NOT include the executable itself (that is ToolSpec.cmd).
   *
   * For runner-tier tools (e.g. npx), include the tool name as first arg:
   *   tier === "runner" → ["tsc", "--noEmit"] rather than just ["--noEmit"]
   */
  buildArgs(projectRoot: string, tool: ToolSpec): string[];
  /**
   * Parse raw tool output into structured diagnostics.
   * Called regardless of exit code — check exitCode if needed.
   * Return [] for a clean run.
   */
  parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    projectRoot: string,
  ): Diagnostic[];
}

// ── Extension configuration ────────────────────────────────────────────────

/**
 * Runtime configuration for the extension.
 * Mutable at runtime via /staticcheck commands.
 */
export interface CheckerConfig {
  /**
   * "auto-fix"    → inject errors into LLM context with triggerTurn:true
   *                 so the LLM immediately tries to fix them.
   * "notify-only" → only update widget / status bar; LLM is not triggered.
   */
  mode: "auto-fix" | "notify-only";
  /** Per-checker execution timeout in ms. Default 30 000. */
  timeout: number;
  /** Max errors shown per checker per turn before truncation. Default 10. */
  maxErrors: number;
  /**
   * Number of consecutive turns with the identical new-error set
   * before a "stuck in a loop" warning is added to the injected message.
   * Default 3.
   */
  loopThreshold: number;
  /** Checker ids that are temporarily disabled. */
  disabled: Set<string>;
}

export const DEFAULT_CONFIG: CheckerConfig = {
  mode: "auto-fix",
  timeout: 30_000,
  maxErrors: 10,
  loopThreshold: 3,
  disabled: new Set(),
};

// ── Per-project state ──────────────────────────────────────────────────────

/**
 * Mutable state tracked per (checker × projectRoot) pair.
 * Stored inside CheckerState.
 */
export interface ProjectCheckState {
  projectRoot: string;
  checkerId: string;
  /**
   * Fingerprints of errors present at check-time of the PREVIOUS turn.
   * null = this project has never been checked (first run for this session).
   *
   * Delta = currentFingerprints − prevFingerprints
   * On the very first run (null), ALL current errors are reported so the
   * LLM knows the full initial state of the project.
   */
  prevFingerprints: Set<string> | null;
  /**
   * Ring buffer of the last `loopThreshold` new-error fingerprint sets.
   * Used to detect when the LLM is repeatedly failing to fix the same errors.
   * Each entry is a sorted, joined string of fingerprints for O(1) comparison.
   */
  recentNewSetKeys: string[];
}
