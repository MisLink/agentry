/**
 * Python checker — prefers mypy, falls back to pyright, then ast.parse.
 *
 * Tool detection order:
 *   1. .venv/bin/mypy  (local venv)
 *   2. mypy on PATH    (system)
 *   3. .venv/bin/pyright (local venv, fallback tool)
 *   4. pyright on PATH
 *   5. uvx mypy        (runner)
 *   6. python3/python   (ast.parse syntax check only — zero external deps)
 */

import { findSystemBin, findUvxRunner, findVenvBin } from "../tool-finder.js";
import { makeDiagnostic, type Diagnostic, type LanguageChecker, type ToolSpec } from "../types.js";
import { relative } from "node:path";

/**
 * Detect a file finder (fd or find) + python3 for the ast.parse fallback.
 * fd is preferred because it respects .gitignore automatically.
 * Python is searched in venv first, then system PATH.
 */
async function detectAstFallback(projectRoot: string): Promise<ToolSpec | null> {
  const python = await findVenvBin(projectRoot, "python3")
    ?? await findVenvBin(projectRoot, "python")
    ?? await findSystemBin("python3")
    ?? await findSystemBin("python");
  if (!python) return null;

  const fd = await findSystemBin("fd");
  if (fd) {
    return {
      cmd: fd.cmd,
      toolId: "python-ast-fd",
      tier: "system",
      displayName: `ast.parse via fd + ${python.displayName}`,
      // stash python cmd for buildArgs
      _pythonCmd: python.cmd,
    } as ToolSpec;
  }

  const find = await findSystemBin("find");
  if (!find) return null;
  return {
    cmd: "find",
    toolId: "python-ast-find",
    tier: "system",
    displayName: `ast.parse via find + ${python.displayName}`,
    _pythonCmd: python.cmd,
  } as ToolSpec;
}

/**
 * Inline Python one-liner for ast.parse. Receives file paths as sys.argv[1:].
 * Used with `find -exec python3 -c '...' {} +` so find handles discovery.
 */
const AST_PARSE_SCRIPT = [
  "import ast,sys",
  "rc=0",
  "for f in sys.argv[1:]:",
  " try:",
  '  ast.parse(open(f,encoding="utf-8",errors="replace").read(),f)',
  " except SyntaxError as e:",
  '  print(f"{e.filename or f}:{e.lineno or 1}:{e.offset or 1}: error: {e.msg or \'SyntaxError\'}");rc=1',
  "sys.exit(rc)",
].join("\n");

/** find exclusions for common non-source directories. */
const FIND_EXCLUDES = [
  ".venv", "venv", ".env", "env",
  "node_modules", "__pycache__", "vendor", "site-packages", ".git", ".hg",
].flatMap((d) => ["-not", "-path", `*/${d}/*`]);

/** fd exclusions (fd uses -E for each pattern). */
const FD_EXCLUDES = [
  ".venv", "venv", ".env", "env",
  "node_modules", "__pycache__", "vendor", "site-packages",
].flatMap((d) => ["-E", d]);

export const pythonChecker: LanguageChecker = {
  id: "python",
  name: "Python",
  extensions: [".py", ".pyi"],
  configFiles: ["pyproject.toml", "setup.py", "setup.cfg", "mypy.ini", ".mypy.ini"],

  async detectTool(projectRoot) {
    return (
      (await findVenvBin(projectRoot, "mypy")) ??
      (await findSystemBin("mypy")) ??
      (await findVenvBin(projectRoot, "pyright")) ??
      (await findSystemBin("pyright")) ??
      (await findUvxRunner("mypy")) ??
      // ast.parse fallback: need file finder + python
      (await detectAstFallback(projectRoot))
    );
  },

  buildArgs(projectRoot, tool) {
    const pythonCmd = (tool as ToolSpec & { _pythonCmd?: string })._pythonCmd ?? "python3";

    // fd: respects .gitignore automatically, -X batches all files into one call
    if (tool.toolId === "python-ast-fd") {
      return [
        "-e", "py",
        ...FD_EXCLUDES,
        "--search-path", projectRoot,
        "-X", pythonCmd, "-c", AST_PARSE_SCRIPT,
      ];
    }

    // find fallback
    if (tool.toolId === "python-ast-find") {
      return [
        projectRoot,
        "-name", "*.py",
        ...FIND_EXCLUDES,
        "-exec", pythonCmd, "-c", AST_PARSE_SCRIPT, "{}", "+",
      ];
    }

    const isPyright =
      tool.toolId === "pyright" ||
      tool.cmd.includes("pyright");

    if (isPyright) {
      const flags = ["--outputjson"];
      if (tool.tier === "runner") return ["pyright", ...flags, projectRoot];
      return [...flags, projectRoot];
    }

    // mypy
    const flags = ["--show-column-numbers", "--no-error-summary", "--no-pretty", "."];
    if (tool.tier === "runner") return ["mypy", ...flags];
    return flags;
  },

  parseOutput(stdout, stderr, exitCode, projectRoot) {
    if (exitCode === 0) return [];

    // Try pyright JSON first.
    const pyrightDiags = tryParsePyrightJson(stdout, projectRoot);
    if (pyrightDiags !== null) return pyrightDiags;

    // Fall back to line-based format (works for mypy, ast.parse, and others).
    return parseLineBasedOutput(stdout + "\n" + stderr, projectRoot);
  },
};

// ── Pyright JSON parser ────────────────────────────────────────────────────

interface PyrightOutput {
  generalDiagnostics?: Array<{
    file: string;
    severity: string;
    message: string;
    range: { start: { line: number; character: number } };
  }>;
}

function tryParsePyrightJson(
  stdout: string,
  projectRoot: string,
): Diagnostic[] | null {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart)) as PyrightOutput;
    if (!Array.isArray(parsed.generalDiagnostics)) return null;

    return parsed.generalDiagnostics
      .filter((d) => d.severity === "error" || d.severity === "warning")
      .map((d) =>
        makeDiagnostic(
          toRelative(d.file, projectRoot),
          d.range.start.line + 1, // pyright uses 0-based lines
          d.range.start.character + 1,
          d.message,
          d.severity as "error" | "warning",
        ),
      );
  } catch {
    return null;
  }
}

// ── Line-based parser (mypy, ast.parse output) ─────────────────────────────

function parseLineBasedOutput(output: string, projectRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // Matches:
  //   path/file.py:10:5: error: message  [error-code]   (mypy)
  //   path/file.py:10: error: message                    (mypy, no column)
  //   path/file.py:10:5: error: message                  (ast.parse)
  const re = /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning):\s+(.+?)(?:\s+\[[\w-]+\])?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const [, rawFile, line, col, sev, msg] = m;
    diagnostics.push(
      makeDiagnostic(
        toRelative(rawFile.trim(), projectRoot),
        parseInt(line, 10),
        col ? parseInt(col, 10) : 1,
        msg.trim(),
        sev as "error" | "warning",
      ),
    );
  }
  return diagnostics;
}

function toRelative(absOrRel: string, root: string): string {
  try {
    return relative(root, absOrRel).replace(/\\/g, "/");
  } catch {
    return absOrRel;
  }
}
