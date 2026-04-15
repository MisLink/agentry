/**
 * Multi-language Static Checker Extension
 *
 * After every agent turn that edits files, runs the appropriate language
 * checker (tsc / mypy / golangci-lint with go vet fallback / cargo check),
 * computes the delta against the previous check, and — in auto-fix mode — injects new errors back into
 * the LLM context so it can fix them immediately.
 *
 * Commands:
 *   /staticcheck          — run checks now (manual trigger)
 *   /staticcheck mode <auto-fix|notify-only>
 *   /staticcheck disable <id>
 *   /staticcheck enable <id>
 *   /staticcheck status
 *
 * CLI flag:
 *   --no-staticcheck      — disable all checkers for this session
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { ALL_CHECKERS, getCheckerForFile } from "./checkers/index.js";
import { buildCombinedWidget, formatCheckResult } from "./formatter.js";
import { clearProjectRootCache, findProjectRoot } from "./project-finder.js";
import { CheckerState } from "./state.js";
import type { Diagnostic, LanguageChecker, ToolSpec } from "./types.js";

export default function staticCheckExtension(pi: ExtensionAPI): void {
  const state = new CheckerState();

  // ── Tool execution ────────────────────────────────────────────────────────

  /**
   * Run a checker tool in the given project directory.
   * Returns raw stdout/stderr/exitCode — never throws (errors are caught).
   */
  function runTool(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const child = execFile(
        cmd,
        args,
        { cwd, timeout: timeoutMs, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err
            ? (typeof err.code === "number" ? err.code : 1)
            : 0;
          resolve({
            stdout: (stdout as string) ?? "",
            stderr: (stderr as string) ?? "",
            code,
          });
        },
      );

      // Step 11: honour AbortSignal for manual /staticcheck skip.
      signal?.addEventListener("abort", () => {
        try {
          child.kill();
        } catch {}
        resolve({ stdout: "", stderr: "", code: 130 });
      });
    });
  }

  // ── Affected-project discovery ────────────────────────────────────────────

  /**
   * Group the modified files by (checker, projectRoot).
   * Returns a flat array of {checker, projectRoot} pairs — ready for
   * parallel execution.
   */
  async function findAffectedProjects(
    modifiedFiles: Set<string>,
  ): Promise<Array<{ checker: LanguageChecker; projectRoot: string }>> {
    const seen = new Set<string>();
    const result: Array<{ checker: LanguageChecker; projectRoot: string }> = [];

    for (const filePath of modifiedFiles) {
      const checker = getCheckerForFile(filePath);
      if (!checker) continue;
      if (state.config.disabled.has(checker.id)) continue;

      const projectRoot = await findProjectRoot(
        dirname(filePath),
        checker.configFiles,
      );
      if (!projectRoot) continue;

      const key = `${checker.id}:${projectRoot}`;
      if (seen.has(key)) continue;
      seen.add(key);

      result.push({ checker, projectRoot });
    }

    return result;
  }

  // ── Per-project check ─────────────────────────────────────────────────────

  /**
   * Detect tool, run checker, return all current diagnostics.
   * Returns null when the tool is unavailable (shows one-time notification).
   */
  async function runCheck(
    checker: LanguageChecker,
    projectRoot: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<Diagnostic[] | null> {
    // Tool detection (cached implicitly by OS path caching)
    let tool: ToolSpec | null;
    try {
      tool = await checker.detectTool(projectRoot);
    } catch {
      tool = null;
    }

    if (!tool) {
      // Step 11 / UX: show one-time "tool missing" notification.
      if (!state.notifiedMissing.has(checker.id)) {
        state.notifiedMissing.add(checker.id);
        ctx.ui.notify(
          `Static check: no ${checker.name} tool found. ` +
            `Install it to enable automatic ${checker.name} checking.`,
          "warning",
        );
      }
      return null;
    }

    const args = checker.buildArgs(projectRoot, tool);
    const { stdout, stderr, code } = await runTool(
      tool.cmd,
      args,
      projectRoot,
      state.config.timeout,
      signal,
    );

    return checker.parseOutput(stdout, stderr, code, projectRoot);
  }

  // ── Widget / status management ────────────────────────────────────────────

  function clearStatusAndWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget("static-check", undefined);
    ctx.ui.setStatus("static-check", undefined);
  }

  function showCheckingStatus(ctx: ExtensionContext, names: string[]): void {
    ctx.ui.setStatus(
      "static-check",
      ctx.ui.theme.fg("muted", `⟳ ${names.join(", ")}`),
    );
  }

  // ── Core flow ─────────────────────────────────────────────────────────────

  /**
   * Run checks on all projects affected by the current turn's edits,
   * compute deltas, update widget, and optionally inject errors into LLM.
   */
  async function checkAndReport(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const affected = await findAffectedProjects(state.modifiedFiles);
    if (affected.length === 0) return;

    // Show "checking…" status for all affected checkers.
    const checkerNames = [...new Set(affected.map((a) => a.checker.name))];
    showCheckingStatus(ctx, checkerNames);

    // Step 11: per-checker timeout via AbortController.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(),
      state.config.timeout + 2_000, // small grace period beyond per-checker timeout
    );
    const effectiveSignal = signal ?? timeoutController.signal;

    try {
      // Run all checks in parallel.
      const checkResults = await Promise.all(
        affected.map(async ({ checker, projectRoot }) => {
          const all = await runCheck(checker, projectRoot, ctx, effectiveSignal);
          if (all === null) return null; // tool missing

          // Step 5: delta vs. last check.
          const newErrors = state.getDelta(checker.id, projectRoot, all);

          // Step 6: loop detection.
          const isLooping = state.recordAndCheckLoop(
            checker.id,
            projectRoot,
            newErrors,
          );

          // Advance baseline for next turn.
          state.updateBaseline(checker.id, projectRoot, all);

          return { checker, projectRoot, newErrors, isLooping };
        }),
      );

      // Discard null results (missing tools).
      const valid = checkResults.filter(
        (r): r is NonNullable<typeof r> => r !== null,
      );

      if (valid.length === 0) {
        clearStatusAndWidget(ctx);
        return;
      }

      // ── Build widget ─────────────────────────────────────────────────────

      const theme = ctx.ui.theme;
      const formatBlocks = valid.map(({ checker, newErrors, isLooping }) => {
        const hasErrors = newErrors.length > 0;
        if (!hasErrors) return { widgetLines: [], hasErrors: false };
        const fmt = formatCheckResult(
          checker.name,
          newErrors,
          state.config,
          isLooping,
          theme,
        );
        return { widgetLines: fmt.widgetLines, hasErrors: true };
      });

      const widgetLines = buildCombinedWidget(formatBlocks, theme);
      const totalNew = valid.reduce((s, r) => s + r.newErrors.length, 0);

      if (totalNew === 0) {
        // All clean this turn.
        ctx.ui.setWidget("static-check", undefined);
        ctx.ui.setStatus(
          "static-check",
          theme.fg("success", "✓ clean"),
        );
        setTimeout(() => ctx.ui.setStatus("static-check", undefined), 3_000);
        return;
      }

      // Show error widget.
      if (widgetLines) {
        ctx.ui.setWidget("static-check", widgetLines, {
          placement: "aboveEditor",
        });
      }
      ctx.ui.setStatus(
        "static-check",
        theme.fg("error", `✗ ${totalNew} err`),
      );

      // ── Inject into LLM (auto-fix) or just notify (notify-only) ─────────

      // Step 7: respect mode.
      if (state.config.mode === "notify-only") {
        ctx.ui.notify(
          `Static check: ${totalNew} new error${totalNew !== 1 ? "s" : ""} (notify-only mode — see widget).`,
          "warning",
        );
        return;
      }

      // Step 9: build combined LLM message and inject.
      const llmParts = valid
        .filter((r) => r.newErrors.length > 0)
        .map(({ checker, newErrors, isLooping }) =>
          formatCheckResult(
            checker.name,
            newErrors,
            state.config,
            isLooping,
            theme,
          ).llmMessage,
        );

      const combined = llmParts.join("\n\n---\n\n");

      pi.sendMessage(
        {
          customType: "static-check-errors",
          content: combined,
          display: true,
        },
        { triggerTurn: true },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Event hooks ───────────────────────────────────────────────────────────

  // Step 4: collect every file the LLM edits during the current agent turn.
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("edit", event)) {
      state.modifiedFiles.add(resolve(ctx.cwd, event.input.path));
    } else if (isToolCallEventType("write", event)) {
      state.modifiedFiles.add(resolve(ctx.cwd, event.input.path));
    }
  });

  // Run checks after all tools in a turn have finished.
  pi.on("agent_end", async (_event, ctx) => {
    try {
      await checkAndReport(ctx);
    } finally {
      state.resetTurn();
    }
  });

  // Reset per-session state on all session lifecycle events.
  const resetSession = async () => {
    state.resetSession();
    clearProjectRootCache();
  };
  pi.on("session_start", resetSession);
  pi.on("session_tree", resetSession);

  // ── CLI flag ──────────────────────────────────────────────────────────────

  pi.registerFlag("no-staticcheck", {
    description: "Disable all static checkers for this session",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-staticcheck") === true) {
      for (const c of ALL_CHECKERS) state.config.disabled.add(c.id);
      ctx.ui.notify("Static check: disabled via --no-staticcheck", "info");
    }
  });

  // ── /staticcheck command ───────────────────────────────────────────────────

  pi.registerCommand("staticcheck", {
    description:
      "Run static checks manually, or configure: mode / disable / enable / status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";

      // /staticcheck mode <auto-fix|notify-only>
      if (sub === "mode") {
        const m = parts[1];
        if (m !== "auto-fix" && m !== "notify-only") {
          ctx.ui.notify("Usage: /staticcheck mode [auto-fix|notify-only]", "error");
          return;
        }
        state.config.mode = m;
        ctx.ui.notify(`Static check mode → ${m}`, "info");
        return;
      }

      // /staticcheck disable <id>
      if (sub === "disable") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /staticcheck disable <checker-id>", "error");
          return;
        }
        state.config.disabled.add(id);
        ctx.ui.notify(`Static check: disabled checker "${id}"`, "info");
        return;
      }

      // /staticcheck enable <id>
      if (sub === "enable") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /staticcheck enable <checker-id>", "error");
          return;
        }
        state.config.disabled.delete(id);
        ctx.ui.notify(`Static check: enabled checker "${id}"`, "info");
        return;
      }

      // /staticcheck status
      if (sub === "status") {
        const checkerList = ALL_CHECKERS.map((c) => {
          const tag = state.config.disabled.has(c.id) ? " [disabled]" : "";
          return `  ${c.id}${tag}`;
        }).join("\n");
        ctx.ui.notify(
          `Static check status\n` +
            `  mode: ${state.config.mode}\n` +
            `  timeout: ${state.config.timeout}ms\n` +
            `  max errors: ${state.config.maxErrors}\n` +
            `Checkers:\n${checkerList}`,
          "info",
        );
        return;
      }

      // Default: scan from ctx.cwd upward to find project roots for each checker.
      //
      // We cannot rely on state.modifiedFiles here: by the time the user types
      // /staticcheck, agent_end has already called resetTurn() which empties it.
      // Instead we walk up from the current directory to find real project roots.
      state.resetSession();

      const found: Array<{ checker: LanguageChecker; projectRoot: string }> = [];
      const seen = new Set<string>();
      for (const checker of ALL_CHECKERS) {
        if (state.config.disabled.has(checker.id)) continue;
        const projectRoot = await findProjectRoot(ctx.cwd, checker.configFiles);
        if (!projectRoot) continue;
        const key = `${checker.id}:${projectRoot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ checker, projectRoot });
      }

      if (found.length === 0) {
        ctx.ui.notify(
          "Static check: no project roots found from current directory. " +
            "Ensure tsconfig.json (TypeScript), pyproject.toml (Python), " +
            "go.mod (Go), or Cargo.toml (Rust) exists in an ancestor directory.",
          "warning",
        );
        return;
      }

      const checkerNames = [...new Set(found.map((f) => f.checker.name))];
      showCheckingStatus(ctx, checkerNames);

      // Run checks directly on the discovered roots and report.
      const results = await Promise.all(
        found.map(async ({ checker, projectRoot }) => {
          const all = await runCheck(checker, projectRoot, ctx);
          return { checker, projectRoot, all };
        }),
      );

      let totalErrors = 0;
      const theme = ctx.ui.theme;
      const formatBlocks: Array<{ widgetLines: string[]; hasErrors: boolean }> = [];

      for (const { checker, projectRoot, all } of results) {
        if (all === null) continue;
        state.updateBaseline(checker.id, projectRoot, all);
        const hasErrors = all.length > 0;
        if (!hasErrors) {
          formatBlocks.push({ widgetLines: [], hasErrors: false });
          continue;
        }
        totalErrors += all.length;
        const fmt = formatCheckResult(checker.name, all, state.config, false, theme);
        formatBlocks.push({ widgetLines: fmt.widgetLines, hasErrors: true });
      }

      if (totalErrors === 0) {
        clearStatusAndWidget(ctx);
        ctx.ui.setStatus("static-check", theme.fg("success", "✓ clean"));
        setTimeout(() => ctx.ui.setStatus("static-check", undefined), 3_000);
        ctx.ui.notify("Static check: no errors found.", "info");
        return;
      }

      const widgetLines = buildCombinedWidget(formatBlocks, theme);
      if (widgetLines) {
        ctx.ui.setWidget("static-check", widgetLines, { placement: "aboveEditor" });
      }
      ctx.ui.setStatus("static-check", theme.fg("error", `✗ ${totalErrors} err`));

      if (state.config.mode === "auto-fix") {
        const llmParts = results
          .filter((r) => r.all !== null && r.all.length > 0)
          .map(({ checker, all }) =>
            formatCheckResult(checker.name, all!, state.config, false, theme).llmMessage,
          );
        if (llmParts.length > 0) {
          pi.sendMessage(
            { customType: "static-check-errors", content: llmParts.join("\n\n---\n\n"), display: true },
            { triggerTurn: true },
          );
        }
      } else {
        ctx.ui.notify(`Static check: ${totalErrors} error(s) found (see widget).`, "warning");
      }
    },
  });
}
