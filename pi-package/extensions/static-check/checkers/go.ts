/**
 * Go checker — uses `go vet ./...`.
 *
 * go is typically always present when a go.mod file exists, so only
 * system-PATH detection is attempted (no local or runner tier).
 */

import { findSystemBin } from "../tool-finder.js";
import { makeDiagnostic, type Diagnostic, type LanguageChecker } from "../types.js";

export const goChecker: LanguageChecker = {
  id: "go",
  name: "Go",
  extensions: [".go"],
  configFiles: ["go.mod"],

  async detectTool(_projectRoot) {
    return await findSystemBin("go");
  },

  buildArgs(_projectRoot, _tool) {
    return ["vet", "./..."];
  },

  parseOutput(stdout, stderr, exitCode, _projectRoot) {
    if (exitCode === 0) return [];

    const diagnostics: Diagnostic[] = [];
    const output = [stdout, stderr].filter(Boolean).join("\n");

    // go vet output:
    //   ./pkg/file.go:10:5: printf: Sprintf format %s has wrong type
    // Build errors also use this format.
    const re = /^(?:\.\/)?(.+?):(\d+):(\d+):\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const [, file, line, col, msg] = m;
      // Skip summary lines that start with "#"
      if (file.startsWith("#")) continue;
      diagnostics.push(
        makeDiagnostic(
          file.replace(/\\/g, "/"),
          parseInt(line, 10),
          parseInt(col, 10),
          msg.trim(),
        ),
      );
    }

    return diagnostics;
  },
};
