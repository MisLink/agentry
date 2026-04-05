/**
 * rtk.ts — RTK token-saving proxy for pi.
 *
 * Delegates all rewrite decisions to `rtk rewrite` (requires rtk ≥ 0.23.0).
 * RTK's Rust binary is the single source of truth for what gets rewritten.
 * Also strips ANSI escape codes from tool results (lossless).
 *
 * Install rtk:
 *   brew install rtk
 *   curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
 *
 * Commands:
 *   /rtk          — toggle on/off
 *   /rtk gain     — cumulative token-savings report
 *   /rtk status   — version and session stats
 */
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

// ─── Constants ────────────────────────────────────────────────────────────────

/** `rtk rewrite` was introduced in 0.23.0. */
const RTK_MIN_MINOR = 23;

/**
 * Comprehensive ANSI / VT escape sequence regex.
 * Covers CSI sequences (colors, cursor movement), OSC sequences, and Fe escapes.
 * Sourced from the well-tested `strip-ansi` npm package pattern.
 */
const ANSI_RE =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_+]*)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_+]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMinor(versionStr: string): number | null {
	const m = versionStr.match(/\d+\.(\d+)\.\d+/);
	return m ? Number(m[1]) : null;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;
	/** rtk is installed AND version ≥ 0.23.0. */
	let rtkReady = false;
	let rtkVersion = "";
	let rewriteCount = 0;

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

	// ── RTK availability check ───────────────────────────────────────────────

	async function checkRtk(ctx: ExtensionContext): Promise<void> {
		try {
			const res = await pi.exec("rtk", ["--version"], { timeout: 5000 });
			if (res.code !== 0) throw new Error("rtk exited non-zero");

			rtkVersion = res.stdout.trim();
			const minor = parseMinor(rtkVersion);
			if (minor === null) throw new Error(`unparseable version: ${rtkVersion}`);

			if (minor < RTK_MIN_MINOR) {
				rtkReady = false;
				ctx.ui.notify(
					`⚠️  rtk ${rtkVersion} is too old (need ≥ 0.${RTK_MIN_MINOR}.0).\n` +
						"Upgrade:  brew upgrade rtk",
					"warning",
				);
			} else {
				rtkReady = true;
			}
		} catch {
			rtkReady = false;
			ctx.ui.notify(
				[
					"⚠️  rtk not found — extension inactive.",
					"",
					"Install:  brew install rtk",
					"or:       curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
					"",
					"Restart pi after installing.",
				].join("\n"),
				"warning",
			);
		}
	}

	// ── Session lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		rewriteCount = 0;
		await checkRtk(ctx);
		refreshStatus(ctx);
	});

	// ── Command rewriting ────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || !rtkReady) return;
		if (!isToolCallEventType("bash", event)) return;

		const original = event.input.command;

		let result: { code: number; stdout: string };
		try {
			// `rtk rewrite` exit codes:
			//   0  rewrite found, auto-allow
			//   1  no RTK equivalent, pass through unchanged
			//   2  deny rule matched, pass through unchanged
			//   3  ask rule matched: rewrite but surface to user
			result = await pi.exec("rtk", ["rewrite", original], { timeout: 2000 });
		} catch {
			return; // rtk unreachable, pass through unchanged
		}

		if (result.code === 1 || result.code === 2) return;

		const rewritten = result.stdout.trim();
		if (!rewritten || rewritten === original) return;

		event.input.command = rewritten;
		rewriteCount++;
		refreshStatus(ctx);

		if (result.code === 3) {
			// Ask rule: rewrite happened but let the user know.
			ctx.ui.notify(`rtk rewrote (ask rule): ${rewritten}`, "info");
		}
	});

	// ── ANSI stripping (lossless output cleanup) ─────────────────────────────

	pi.on("tool_result", async (event, _ctx) => {
		if (!enabled) return;

		const blocks = event.content;
		let changed = false;

		const cleaned = blocks.map((block) => {
			if (block.type !== "text") return block;
			const stripped = stripAnsi(block.text);
			if (stripped === block.text) return block;
			changed = true;
			return { ...block, text: stripped } satisfies TextContent;
		}) satisfies (TextContent | ImageContent)[];

		if (!changed) return;
		return { content: cleaned };
	});

	// ── /rtk command ─────────────────────────────────────────────────────────

	pi.registerCommand("rtk", {
		description: "Toggle rtk on/off · subcommands: gain, status",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "gain", label: "gain — cumulative token-savings report" },
				{ value: "status", label: "status — version and session stats" },
			].filter((s) => s.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase() ?? "";

			if (sub === "gain") {
				if (!rtkReady) {
					ctx.ui.notify("rtk not available", "warning");
					return;
				}
				const res = await pi.exec("rtk", ["gain"], {});
				ctx.ui.notify(res.stdout || res.stderr || "No stats yet.", "info");
				return;
			}

			if (sub === "status") {
				ctx.ui.notify(
					[
						rtkReady ? `✅ rtk  ${rtkVersion}` : "❌ rtk unavailable",
						`   enabled  : ${enabled}`,
						`   rewrites : ${rewriteCount} this session`,
					].join("\n"),
					"info",
				);
				return;
			}

			// Default (no args): toggle on/off
			enabled = !enabled;
			ctx.ui.notify(`rtk ${enabled ? "enabled ✓" : "disabled"}`, enabled ? "info" : "warning");
			refreshStatus(ctx);
		},
	});
}
