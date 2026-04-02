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
import { relative } from "node:path";

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
    const flags = ["--noEmit", "--pretty", "false"];
    // For runner (npx), prepend the real tool name.
    return tool.tier === "runner" ? ["tsc", ...flags] : flags;
  },

  parseOutput(stdout, stderr, exitCode, projectRoot) {
    if (exitCode === 0) return [];

    const diagnostics: Diagnostic[] = [];
    const output = [stdout, stderr].filter(Boolean).join("\n");

    // tsc --pretty false format:
    //   src/file.ts(10,5): error TS2322: Type 'string' is not assignable …
    const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const [, rawFile, line, col, sev, msg] = m;
      diagnostics.push(
        makeDiagnostic(
          toRelative(rawFile.trim(), projectRoot),
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

function toRelative(absOrRel: string, root: string): string {
  try {
    return relative(root, absOrRel).replace(/\\/g, "/");
  } catch {
    return absOrRel;
  }
}
