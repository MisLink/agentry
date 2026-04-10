/**
 * Three-tier tool discovery helpers.
 *
 * Each LanguageChecker.detectTool() calls these helpers in priority order:
 *
 *   Tier 1 — project-local  : node_modules/.bin, .venv/bin, etc.
 *   Tier 2 — system PATH    : bare command resolved via `which`
 *   Tier 3 — package runner : npx (Node), uvx (Python)
 *
 * Helpers return null when the candidate is not available, so checkers can
 * chain them with the `??` operator and fall through to the next tier.
 */

import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ToolSpec } from "./types.js";

// ── Internal helpers ───────────────────────────────────────────────────────

/** Returns true if the path exists and is executable. */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command with a short timeout and return whether it succeeded.
 * Used only for presence-checking (e.g. `which tsc`).
 */
function probeCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 3_000 }, (err) => {
      resolve(!err);
    });
    child.on("error", () => resolve(false));
  });
}

// ── Tier 1: project-local ──────────────────────────────────────────────────

/**
 * Look for a tool in <projectRoot>/node_modules/.bin/<name>.
 * Used for TypeScript (tsc), ESLint, etc.
 */
export async function findLocalNodeBin(
  projectRoot: string,
  toolId: string,
): Promise<ToolSpec | null> {
  const p = join(projectRoot, "node_modules", ".bin", toolId);
  if (await isExecutable(p)) {
    return { cmd: p, toolId, tier: "local", displayName: `${toolId} (local)` };
  }
  return null;
}

/**
 * Look for a tool in a Python virtual-environment inside the project.
 * Checks .venv/bin, venv/bin, and .env/bin (common virtualenv names).
 */
export async function findVenvBin(
  projectRoot: string,
  toolId: string,
): Promise<ToolSpec | null> {
  for (const venvDir of [".venv", "venv", ".env"]) {
    const p = join(projectRoot, venvDir, "bin", toolId);
    if (await isExecutable(p)) {
      return { cmd: p, toolId, tier: "local", displayName: `${toolId} (venv)` };
    }
  }
  return null;
}

// ── Tier 2: system PATH ────────────────────────────────────────────────────

/**
 * Check whether <name> exists on the system PATH using `which`.
 * Returns a ToolSpec with cmd === name (bare, relies on PATH at exec time).
 */
export async function findSystemBin(name: string): Promise<ToolSpec | null> {
  const found = await probeCommand("which", [name]);
  if (found) {
    return { cmd: name, toolId: name, tier: "system", displayName: `${name} (system)` };
  }
  return null;
}

// ── Tier 3: package runners ────────────────────────────────────────────────

/**
 * Check whether `npx` is available and return a runner ToolSpec for it.
 *
 * When tier === "runner", LanguageChecker.buildArgs() must prepend the
 * real tool name as the first argument:
 *   npx tsc --noEmit  →  cmd="npx", args=["tsc", "--noEmit"]
 */
export async function findNpxRunner(toolId: string): Promise<ToolSpec | null> {
  const found = await probeCommand("npx", ["--version"]);
  if (found) {
    return {
      cmd: "npx",
      toolId,
      tier: "runner",
      displayName: `${toolId} (npx)`,
    };
  }
  return null;
}

/**
 * Check whether `uvx` is available and return a runner ToolSpec for it.
 * uvx is the uv package runner (https://github.com/astral-sh/uv).
 *
 * Same convention as npx: buildArgs() must prepend the tool name.
 */
export async function findUvxRunner(toolId: string): Promise<ToolSpec | null> {
  const found = await probeCommand("uvx", ["--version"]);
  if (found) {
    return {
      cmd: "uvx",
      toolId,
      tier: "runner",
      displayName: `${toolId} (uvx)`,
    };
  }
  return null;
}
