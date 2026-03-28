/**
 * RTK (Rust Token Killer) Wrapper Extension for pi
 *
 * Wraps bash commands with RTK to save 60-90% on token usage,
 * similar to Claude Code's PreToolUse hook approach.
 *
 * Installation:
 *   cp rtk-wrapper.ts ~/.pi/agent/extensions/
 *   or symlink from your agentry project
 *
 * Usage:
 *   pi (auto-loaded from extensions directory)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";

// Commands that should NOT be wrapped with RTK
// RTK wraps tools like git, npm, cargo, etc. - not all commands benefit
const SKIP_PATTERNS = [
  /^\s*rtk\s/,           // Already wrapped
  /^\s*source\s/,        // Shell source commands
  /^\s*\.\s/,            // Shell dot commands
  /^\s*export\s/,        // Export statements
  /^\s*alias\s/,         // Alias definitions
  /^\s*cd\s/,            // Directory changes
  /^\s*pushd\s/,         // Directory stack
  /^\s*popd\s/,          // Directory stack
];

function shouldSkipRtk(command: string): boolean {
  return SKIP_PATTERNS.some(pattern => pattern.test(command));
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => {
      // Skip if command shouldn't be wrapped
      if (shouldSkipRtk(command)) {
        return { command, cwd, env };
      }

      // Wrap with RTK - this is the key transformation
      // RTK intercepts the command and optimizes output
      return {
        command: `rtk ${command}`,
        cwd,
        env: { ...env, PI_RTK_WRAPPER: "1" },
      };
    },
  });

  pi.registerTool({
    ...bashTool,
    // Keep the same name to override built-in bash tool
    // Inherits all built-in rendering (command display, output, etc.)
    execute: async (id, params, signal, onUpdate, _ctx) => {
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });

  // Optional: Register a command to toggle RTK wrapper
  let rtkEnabled = true;

  pi.registerCommand("rtk-toggle", {
    description: "Toggle RTK wrapper on/off",
    handler: async (_args, ctx) => {
      rtkEnabled = !rtkEnabled;
      ctx.ui.notify(
        `RTK wrapper ${rtkEnabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });

  // Optional: Register a command to check RTK status
  pi.registerCommand("rtk-status", {
    description: "Show RTK wrapper status and token savings",
    handler: async (_args, ctx) => {
      try {
        // Try to run rtk gain to show savings
        const result = await pi.exec("rtk", ["gain"], { timeout: 5000 });
        if (result.code === 0) {
          ctx.ui.notify(`RTK Status: ${rtkEnabled ? "Active" : "Inactive"}\n\n${result.stdout}`, "info");
        } else {
          ctx.ui.notify(`RTK Status: ${rtkEnabled ? "Active" : "Inactive"}\n\n(Could not fetch savings data)`, "info");
        }
      } catch {
        ctx.ui.notify(`RTK Status: ${rtkEnabled ? "Active" : "Inactive"}`, "info");
      }
    },
  });

  // Log on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("rtk", "RTK: Active");
    ctx.ui.notify("RTK wrapper loaded - commands will be optimized", "info");
  });

  // Clean up status on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("rtk", undefined);
  });
}
