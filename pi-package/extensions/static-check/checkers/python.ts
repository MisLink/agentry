/**
 * Python checker — prefers mypy, falls back to pyright.
 *
 * Tool detection order:
 *   1. .venv/bin/mypy  (local venv)
 *   2. mypy on PATH    (system)
 *   3. .venv/bin/pyright (local venv, fallback tool)
 *   4. pyright on PATH
 *   5. uvx mypy        (runner)
 */

import { findSystemBin, findUvxRunner, findVenvBin } from "../tool-finder.js";
import { makeDiagnostic, type Diagnostic, type LanguageChecker } from "../types.js";
import { relative } from "node:path";

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
      (await findUvxRunner("mypy"))
    );
  },

  buildArgs(projectRoot, tool) {
    const isPyright =
      tool.toolId === "pyright" ||
      tool.cmd.includes("pyright");

    if (isPyright) {
      // pyright [flags] <directory>
      const flags = ["--outputjson"];
      if (tool.tier === "runner") return ["pyright", ...flags, projectRoot];
      return [...flags, projectRoot];
    }

    // mypy: check the entire project directory
    const flags = ["--show-column-numbers", "--no-error-summary", "--no-pretty", "."];
    if (tool.tier === "runner") return ["mypy", ...flags];
    return flags;
  },

  parseOutput(stdout, stderr, exitCode, projectRoot) {
    if (exitCode === 0) return [];

    // Try pyright JSON first.
    const pyrightDiags = tryParsePyrightJson(stdout, projectRoot);
    if (pyrightDiags !== null) return pyrightDiags;

    // Fall back to mypy text format.
    return parseMypyText(stdout + "\n" + stderr, projectRoot);
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

// ── Mypy text parser ───────────────────────────────────────────────────────

function parseMypyText(output: string, projectRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // mypy: path/file.py:10:5: error: message  [error-code]
  // Also without column: path/file.py:10: error: message
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
