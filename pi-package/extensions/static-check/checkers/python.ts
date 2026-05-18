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
import { isAbsolute, relative } from "node:path";

/**
 * Detect python3/python for the ast.parse fallback.
 * Python is searched in venv first, then system PATH.
 */
async function detectAstFallback(projectRoot: string): Promise<ToolSpec | null> {
  const python = await findVenvBin(projectRoot, "python3")
    ?? await findVenvBin(projectRoot, "python")
    ?? await findSystemBin("python3")
    ?? await findSystemBin("python");
  if (!python) return null;

  return {
    cmd: python.cmd,
    toolId: "python-ast",
    tier: python.tier,
    displayName: `ast.parse via ${python.displayName}`,
  };
}

const PYTHON_EXCLUDED_DIRS = [
  ".venv", "venv", ".env", "env",
  "node_modules", "__pycache__", "vendor", "site-packages", ".git", ".hg",
];

/**
 * Inline Python script for ast.parse. Receives file or directory targets as
 * sys.argv[1:]. Directory targets are walked recursively with common generated
 * / dependency directories excluded.
 */
const AST_PARSE_SCRIPT = [
  "import ast,os,sys",
  `EXCLUDED=${JSON.stringify(PYTHON_EXCLUDED_DIRS)}`,
  "def iter_files(target):",
  " if os.path.isfile(target):",
  "  if target.endswith('.py'): yield target",
  "  return",
  " for root, dirs, files in os.walk(target):",
  "  dirs[:] = [d for d in dirs if d not in EXCLUDED]",
  "  for name in files:",
  "   if name.endswith('.py'): yield os.path.join(root, name)",
  "rc=0",
  "for target in sys.argv[1:] or ['.']:",
  " for f in iter_files(target):",
  "  try:",
  '   ast.parse(open(f,encoding="utf-8",errors="replace").read(),f)',
  "  except SyntaxError as e:",
  '   print(f"{e.filename or f}:{e.lineno or 1}:{e.offset or 1}: error: {e.msg or \'SyntaxError\'}");rc=1',
  "sys.exit(rc)",
].join("\n");

function pythonTargets(projectRoot: string, scopedFiles?: string[]): string[] {
  if (!scopedFiles || scopedFiles.length === 0) return ["."];

  const targets = new Set<string>();
  for (const file of scopedFiles) {
    const rel = isAbsolute(file) ? relative(projectRoot, file) : file;
    if (!rel || rel.startsWith("..")) continue;
    targets.add(rel.replace(/\\/g, "/"));
  }

  return targets.size > 0 ? [...targets].sort() : ["."];
}

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

  buildArgs(projectRoot, tool, scopedFiles) {
    const targets = pythonTargets(projectRoot, scopedFiles);

    if (tool.toolId === "python-ast") {
      return ["-c", AST_PARSE_SCRIPT, ...targets];
    }

    const isPyright =
      tool.toolId === "pyright" ||
      tool.cmd.includes("pyright");

    if (isPyright) {
      const flags = ["--outputjson", ...targets];
      if (tool.tier === "runner") return ["pyright", ...flags];
      return flags;
    }

    // mypy
    const flags = ["--show-column-numbers", "--no-error-summary", "--no-pretty", ...targets];
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
  const trimmed = stdout.trimStart();
  if (!trimmed.startsWith("{")) return null;
  const jsonStart = stdout.indexOf("{");

  let parsed: PyrightOutput;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart)) as PyrightOutput;
  } catch {
    // stdout starts with '{' — this is JSON output mode. If JSON.parse fails,
    // the output is corrupted or truncated. Surface the error explicitly
    // instead of falling through to a line-based parser that will find nothing.
    throw new Error(`pyright JSON output is malformed — possible truncation or encoding issue`);
  }

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
  if (isAbsolute(absOrRel)) return relative(root, absOrRel).replace(/\\/g, "/");
  return absOrRel.replace(/\\/g, "/");
}
