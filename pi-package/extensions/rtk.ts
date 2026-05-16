/**
 * rtk.ts — RTK token-saving proxy for pi.
 *
 * Uses `rtk rewrite` (requires rtk ≥ 0.23.0) to optimize shell commands.
 * Covers both agent-initiated bash tool calls and user-issued `!<cmd>` commands.
 * Commands entered with `!!<cmd>` are intentionally not intercepted.
 *
 * Install rtk:
 *   brew install rtk
 *   curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
 *
 * Commands:
 *   /rtk          — overlay toggle (enable / disable / status)
 *   /rtk gain     — cumulative token-savings report
 *   /rtk status   — version and session stats
 */
import { spawnSync } from "node:child_process";
import {
	createLocalBashOperations,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── Constants ────────────────────────────────────────────────────────────────

/** `rtk rewrite` was introduced in 0.23.0. */
const RTK_MIN_MINOR = 23;
const REWRITE_TIMEOUT_MS = 5000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMinor(versionStr: string): number | null {
	const m = versionStr.match(/\d+\.(\d+)\.\d+/);
	return m ? Number(m[1]) : null;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let rtkReady = false;
	let rtkVersion = "";
	let rewriteCount = 0;
	let warnedUnavailable = false;

	const localBashOperations = createLocalBashOperations();

	// ── Status bar ───────────────────────────────────────────────────────────

	function refreshStatus(ctx: ExtensionContext): void {
		if (!rtkReady) {
			ctx.ui.setStatus("rtk", undefined);
			return;
		}
		if (!enabled) {
			ctx.ui.setStatus("rtk", ctx.ui.theme.fg("muted", "rtk off"));
			return;
		}
		const badge = rewriteCount > 0 ? `  ${rewriteCount}↺` : "";
		ctx.ui.setStatus("rtk", `🔧 rtk${badge}`);
	}

	function showStatus(ctx: ExtensionContext): void {
		ctx.ui.notify(
			[
				rtkReady ? `✅ rtk  ${rtkVersion}` : "❌ rtk unavailable",
				`   enabled  : ${enabled}`,
				`   rewrites : ${rewriteCount} this session`,
				"",
				"Tip: bypass rtk for one command with !RTK_DISABLED=1 <cmd>",
			].join("\n"),
			"info",
		);
	}

	function showGain(ctx: ExtensionContext): void {
		if (!rtkReady) {
			ctx.ui.notify("rtk not available", "warning");
			return;
		}
		const res = spawnSync("rtk", ["gain"], {
			encoding: "utf-8",
			timeout: REWRITE_TIMEOUT_MS,
		});
		ctx.ui.notify(res.stdout?.trim() || res.stderr?.trim() || "No stats yet.", "info");
	}

	// ── RTK availability check ───────────────────────────────────────────────

	function checkRtk(ctx: ExtensionContext): void {
		try {
			const res = spawnSync("rtk", ["--version"], {
				encoding: "utf-8",
				timeout: REWRITE_TIMEOUT_MS,
			});

			if (res.error) {
				throw res.error;
			}
			if (res.status !== 0) {
				throw new Error("rtk exited non-zero");
			}

			rtkVersion = (res.stdout ?? "").trim();
			const minor = parseMinor(rtkVersion);
			if (minor === null) throw new Error(`unparseable version: ${rtkVersion}`);

			if (minor < RTK_MIN_MINOR) {
				rtkReady = false;
				if (!warnedUnavailable) {
					warnedUnavailable = true;
					ctx.ui.notify(
						`⚠️  rtk ${rtkVersion} is too old (need ≥ 0.${RTK_MIN_MINOR}.0).\n` +
							"Upgrade:  brew upgrade rtk",
						"warning",
					);
				}
			} else {
				rtkReady = true;
				warnedUnavailable = false;
			}
		} catch (err: unknown) {
			rtkReady = false;
			if (!warnedUnavailable) {
				warnedUnavailable = true;
				const errno = (err as NodeJS.ErrnoException).code;
				const hint =
					errno === "EACCES"
						? "rtk binary found but not executable. Run: chmod +x $(command -v rtk)"
						: [
								"⚠️  rtk not found — extension inactive.",
								"",
								"Install:  brew install rtk",
								"or:       curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
								"",
								"Restart pi after installing.",
							].join("\n");
				ctx.ui.notify(`⚠️  ${hint}`, "warning");
			}
		}
	}

	// ── Core rewrite (shared by tool_call and user_bash) ─────────────────────

	function rtkRewrite(command: string): string | undefined {
		if (!enabled || !rtkReady) return undefined;

		try {
			const res = spawnSync("rtk", ["rewrite", command], {
				encoding: "utf-8",
				timeout: REWRITE_TIMEOUT_MS,
			});

			if (res.error) return undefined;

			// Exit codes: 0=rewritten, 1=no equivalent, 2=deny, 3=ask
			// For 1/2/3 stdout is empty or same → no rewrite
			const out = (res.stdout ?? "").trim();
			return out.length > 0 && out !== command ? out : undefined;
		} catch {
			return undefined;
		}
	}

	// ── Session lifecycle ────────────────────────────────────────────────────

	function handleRewrite(original: string, rewritten: string): void {
		rewriteCount++;
	}

	pi.on("session_start", (_event, ctx) => {
		rewriteCount = 0;
		checkRtk(ctx);
		refreshStatus(ctx);
	});

	// ── Agent bash tool calls ────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || !rtkReady) return;
		if (!isToolCallEventType("bash", event)) return;

		const rewritten = rtkRewrite(event.input.command);
		if (rewritten) {
			const original = event.input.command;
			event.input.command = rewritten;
			handleRewrite(original, rewritten);
			refreshStatus(ctx);
		}
	});

	// ── User !<cmd> shell commands ───────────────────────────────────────────

	pi.on("user_bash", (event, _ctx) => {
		// !!<cmd> → context-excluded, don't intercept
		if (event.excludeFromContext) return;
		if (!enabled || !rtkReady) return;

		const rewritten = rtkRewrite(event.command);
		if (!rewritten) return;

		handleRewrite(event.command, rewritten);
		return {
			operations: {
				exec: (_command, cwd, options) =>
					localBashOperations.exec(rewritten, cwd, options),
			},
		};
	});

	// ── /rtk command ─────────────────────────────────────────────────────────

	pi.registerCommand("rtk", {
		description: "Toggle rtk on/off · subcommands: enable, disable, status, gain",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "enable", label: "enable — turn on rewriting" },
				{ value: "disable", label: "disable — turn off rewriting" },
				{ value: "gain", label: "gain — cumulative token-savings report" },
				{ value: "status", label: "status — version and session stats" },
			].filter((s) => s.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase() ?? "";

			if (sub === "enable") {
				enabled = true;
				ctx.ui.notify("rtk enabled ✓", "info");
				refreshStatus(ctx);
				return;
			}

			if (sub === "disable") {
				enabled = false;
				ctx.ui.notify("rtk disabled", "warning");
				refreshStatus(ctx);
				return;
			}

			if (sub === "gain") {
				showGain(ctx);
				return;
			}

			if (sub === "status") {
				showStatus(ctx);
				return;
			}

			// No args → overlay
			const selected = await ctx.ui.select("rtk", ["enable", "disable", "status", "gain"]);
			if (!selected) return;

			if (selected === "enable") {
				enabled = true;
				ctx.ui.notify("rtk enabled ✓", "info");
			} else if (selected === "disable") {
				enabled = false;
				ctx.ui.notify("rtk disabled", "warning");
			} else if (selected === "status") {
				showStatus(ctx);
			} else if (selected === "gain") {
				showGain(ctx);
			}
			refreshStatus(ctx);
		},
	});
}
