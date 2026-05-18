/**
 * TypeScript checker — uses tsc --noEmit.
 *
 * Tool detection order:
 *   1. <projectRoot>/node_modules/.bin/tsc   (local)
 *   2. tsc on system PATH                    (system)
 *   3. npx tsc                               (runner fallback)
 */

import { findLocalNodeBin, findNpxRunner, findSystemBin } from "../tool-finder.js";
import { makeDiagnostic, type Diagnostic, type LanguageChecker, type ToolSpec } from "../types.js";
import { isAbsolute, relative } from "node:path";

export const typescriptChecker: LanguageChecker = {
  id: "typescript",
  name: "TypeScript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  configFiles: ["tsconfig.json"],

  async detectTool(projectRoot) {
    return (
      (await findLocalNodeBin(projectRoot, "tsc")) ??
      (await findSystemBin("tsc")) ??
      (await findNpxRunner("tsc"))
    );
  },

  buildArgs(_projectRoot, tool) {
    // tsc cannot combine --project with an explicit file list. Keep the
    // project-level check for correctness, then filter diagnostics to scoped
    // files in parseOutput() for automatic runs.
    const flags = ["--noEmit", "--pretty", "false"];
    // For runner (npx), prepend the real tool name.
    return tool.tier === "runner" ? ["tsc", ...flags] : flags;
  },

  parseOutput(stdout, stderr, exitCode, projectRoot, _tool, scopedFiles) {
    if (exitCode === 0) return [];

    const scoped = scopedFileSet(projectRoot, scopedFiles);
    const diagnostics: Diagnostic[] = [];
    const output = [stdout, stderr].filter(Boolean).join("\n");

    // tsc --pretty false format:
    //   src/file.ts(10,5): error TS2322: Type 'string' is not assignable …
    const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const [, rawFile, line, col, sev, msg] = m;
      const file = toRelative(rawFile.trim(), projectRoot);
      if (scoped && !scoped.has(file)) continue;
      diagnostics.push(
        makeDiagnostic(
          file,
          parseInt(line, 10),
          parseInt(col, 10),
          msg.trim(),
          sev as "error" | "warning",
        ),
      );
    }

    return diagnostics;
  },
};

function scopedFileSet(root: string, scopedFiles?: string[]): Set<string> | null {
  if (!scopedFiles || scopedFiles.length === 0) return null;
  const files = new Set<string>();
  for (const file of scopedFiles) {
    const rel = toRelative(file, root);
    if (!rel || rel.startsWith("..")) continue;
    files.add(rel);
  }
  return files.size > 0 ? files : null;
}

function toRelative(absOrRel: string, root: string): string {
  const rel = isAbsolute(absOrRel) ? relative(root, absOrRel) : absOrRel;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}
