/**
 * Rust checker — uses `cargo check --message-format short`.
 *
 * cargo is expected to be on PATH when a Cargo.toml is present.
 */

import { findSystemBin } from "../tool-finder.js";
import { makeDiagnostic, type Diagnostic, type LanguageChecker } from "../types.js";
import { relative } from "node:path";

export const rustChecker: LanguageChecker = {
  id: "rust",
  name: "Rust",
  extensions: [".rs"],
  configFiles: ["Cargo.toml"],

  async detectTool(_projectRoot) {
    return await findSystemBin("cargo");
  },

  buildArgs(_projectRoot, _tool) {
    return ["check", "--message-format", "short", "--quiet"];
  },

  parseOutput(stdout, stderr, exitCode, projectRoot) {
    if (exitCode === 0) return [];

    const diagnostics: Diagnostic[] = [];
    const output = [stdout, stderr].filter(Boolean).join("\n");

    // cargo check --message-format short output:
    //   src/main.rs:10:5: error[E0308]: mismatched types
    //   src/lib.rs:3:1: warning[unused_variables]: unused variable: `x`
    const re = /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[[\w]+\])?:\s+(.+)$/gm;
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
