/**
 * index.ts — BTW side-chat extension entry point.
 *
 * Registers a /btw command and Ctrl+Alt+B shortcut that open a floating
 * side-chat overlay backed by a dedicated AgentSession seeded with the
 * full main-conversation context.
 *
 * Commands:
 *   /btw [question]  open overlay, or ask inline if question provided
 *   /btw reset       clear the current side thread (no dialog)
 *   /btw inject      summarise thread and send to main chat (no dialog)
 *   /btw status      show thread size and cumulative token usage
 *
 * Shortcut: Ctrl+Alt+B — open / focus the overlay
 *
 * Key improvements over the original btw.ts:
 *   [step 3]  Context capture fix: latestCtx is updated on every command/shortcut
 *             invocation, so overlay onSubmit always has a fresh, valid context.
 *             runBtwPrompt accepts ExtensionContext (not the command-only variant)
 *             since it never actually calls waitForIdle().
 *   [step 4]  Scrollable transcript via ↑/↓ in BtwOverlay.
 *   [step 5]  Overlay is created once and reused; busy/focus state kept in sync.
 *   [step 6]  Cancel in-flight request with Esc (when busy).
 *   [step 7]  /btw reset | inject | status subcommands.
 *   [step 10] Ctrl+Alt+B keyboard shortcut.
 *   [step 11] Lifecycle events: session_start/switch/tree, model_select, shutdown.
 */
import {
	getMarkdownTheme,
	BorderedLoader,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { getModelForSlot } from "../../lib/model-router.js";
import { Key, Markdown, truncateToWidth, type OverlayHandle } from "@mariozechner/pi-tui";
import {
	BtwThread,
	BTW_ENTRY_TYPE,
	BTW_RESET_TYPE,
	type BtwDetails,
	type BtwResetDetails,
	type ToolCallInfo,
} from "./thread.js";
import {
	SideSessionManager,
	extractAssistantText,
	extractStreamedText,
	getLastAssistantMessage,
	summarise,
} from "./session.js";
import { BtwOverlay, formatUsage } from "./overlay.js";

export default function (pi: ExtensionAPI) {
	// ── Core state ────────────────────────────────────────────────────────────

	const thread = new BtwThread();
	const sideSession = new SideSessionManager();
	const mdTheme = getMarkdownTheme();

	let sideBusy = false;
	let overlayStatus = "Ready";
	/** Draft text preserved when the overlay is closed and restored on reopen. */
	let overlayDraft = "";
	/**
	 * Flag set by cancelRequest() before aborting the session. Lets runBtwPrompt
	 * distinguish a user-initiated cancel from an unexpected error.
	 */
	let promptAborted = false;

	/**
	 * Most recent ExtensionContext, updated every time the /btw command or
	 * Ctrl+Alt+B shortcut fires.
	 *
	 * runBtwPrompt only needs ExtensionContext (not ExtensionCommandContext) —
	 * it never calls waitForIdle(). So any context captured here is sufficient
	 * for submitting questions from the overlay, regardless of how the overlay
	 * was opened (command, shortcut, or lifecycle event).
	 */
	let latestCtx: ExtensionContext | null = null;

	// ── Overlay runtime ───────────────────────────────────────────────────────

	type OverlayRuntime = {
		handle?: OverlayHandle;
		overlay?: BtwOverlay;
		/** Trigger a TUI re-render and sync overlay.busy with sideBusy. */
		refresh: () => void;
		/** Save draft, hide overlay, and reset runtime to no-op defaults. */
		close: () => void;
		closed?: boolean;
		finish?: () => void;
	};

	const noOp = () => {};
	let overlayRuntime: OverlayRuntime = { refresh: noOp, close: noOp };

	// ── Status helpers ────────────────────────────────────────────────────────

	function setStatus(status: string): void {
		overlayStatus = status;
		overlayRuntime.refresh();
	}

	/**
	 * Build the status line text shown in the overlay.
	 * Appends last-response token usage when available, e.g. "Ready · ↑1.2k ↓340 $0.0012".
	 */
	function buildStatusText(): string {
		const usageStr = formatUsage(thread.lastUsage);
		return usageStr ? `${overlayStatus} · ${usageStr}` : overlayStatus;
	}

	function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error"): void {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	}

	// ── Transcript rendering ──────────────────────────────────────────────────

	function renderMarkdownLines(text: string, width: number): string[] {
		if (!text) return [];
		try {
			return new Markdown(text, 0, 0, mdTheme).render(width);
		} catch {
			// Fall back to simple line-wrapping if Markdown rendering fails.
			return text.split("\n").flatMap((line) => {
				if (!line) return [""];
				const chunks: string[] = [];
				for (let i = 0; i < line.length; i += width) {
					chunks.push(line.slice(i, i + width));
				}
				return chunks.length > 0 ? chunks : [""];
			});
		}
	}

	function renderToolCalls(calls: ToolCallInfo[], theme: Theme, width: number): string[] {
		return calls.map((tc) => {
			const icon = tc.status === "running" ? "⚙" : tc.status === "error" ? "✗" : "✓";
			const color = tc.status === "error" ? "error" : tc.status === "done" ? "success" : "dim";
			const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", tc.toolName);
			const argsText = tc.args ? theme.fg("dim", ` ${tc.args}`) : "";
			return truncateToWidth(`  ${label}${argsText}`, width, "");
		});
	}

	function formatToolArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		switch (toolName) {
			case "bash":
				return typeof a.command === "string"
					? truncateToWidth(a.command.split("\n")[0], 50, "…")
					: "";
			case "read":
			case "write":
			case "edit":
				return typeof a.path === "string" ? a.path : "";
			default: {
				const first = Object.values(a)[0];
				return typeof first === "string"
					? truncateToWidth(first.split("\n")[0], 40, "…")
					: "";
			}
		}
	}

	function getTranscriptLines(width: number, theme: Theme): string[] {
		try {
			return buildTranscriptLines(width, theme);
		} catch (error) {
			return [theme.fg("error", `Render error: ${error instanceof Error ? error.message : String(error)}`)];
		}
	}

	function buildTranscriptLines(width: number, theme: Theme): string[] {
		if (thread.isEmpty) {
			return [theme.fg("dim", "No messages yet. Type a question below.")];
		}

		const lines: string[] = [];

		for (const item of thread.items) {
			const userText = item.question.trim().split("\n")[0];
			lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
			lines.push("");
			lines.push(...renderMarkdownLines(item.answer, width));
			lines.push("");
		}

		if (thread.pendingQuestion) {
			const userText = thread.pendingQuestion.trim().split("\n")[0];
			lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));

			if (thread.pendingToolCalls.length > 0) {
				lines.push(...renderToolCalls(thread.pendingToolCalls, theme, width));
			}

			if (thread.pendingError) {
				lines.push(theme.fg("error", `❌ ${thread.pendingError}`));
			} else if (thread.pendingAnswer) {
				lines.push("");
				lines.push(...renderMarkdownLines(thread.pendingAnswer, width));
			} else if (thread.pendingToolCalls.length === 0) {
				lines.push(theme.fg("dim", "…"));
			}
		}

		// Trim trailing blank lines.
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	}

	// ── Side session event handler ────────────────────────────────────────────

	function handleSideEvent(event: AgentSessionEvent): void {
		if (!sideBusy || !thread.pendingQuestion) return;

		switch (event.type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				const streamed = extractStreamedText((event as { message?: unknown }).message);
				if (streamed) {
					thread.pendingAnswer = streamed;
					thread.pendingError = null;
				}
				setStatus(
					event.type === "message_end" ? "Finalising response…" : "Streaming response…",
				);
				return;
			}
			case "tool_execution_start": {
				const ev = event as { toolName?: string; toolCallId?: string; args?: unknown };
				const toolName = ev.toolName ?? "unknown";
				thread.pendingToolCalls.push({
					toolCallId: ev.toolCallId ?? "",
					toolName,
					args: formatToolArgs(toolName, ev.args),
					status: "running",
				});
				setStatus(`Running tool: ${toolName}…`);
				return;
			}
			case "tool_execution_end": {
				const ev = event as { toolName?: string; isError?: boolean };
				const tc = thread.pendingToolCalls.find(
					(t) => t.toolName === (ev.toolName ?? "") && t.status === "running",
				);
				if (tc) tc.status = ev.isError ? "error" : "done";
				setStatus("Streaming response…");
				return;
			}
			case "turn_end":
				setStatus("Finalising response…");
				return;
			default:
				return;
		}
	}

	// ── Overlay lifecycle ─────────────────────────────────────────────────────

	function dismissOverlay(): void {
		overlayRuntime.close();
	}

	async function openOverlay(ctx: ExtensionContext): Promise<void> {
		latestCtx = ctx;
		if (!ctx.hasUI) return;

		// Re-focus an already-open overlay instead of creating a second one.
		if (overlayRuntime.handle) {
			overlayRuntime.handle.setHidden(false);
			overlayRuntime.handle.focus();
			overlayRuntime.refresh();
			return;
		}

		const runtime: OverlayRuntime = { refresh: noOp, close: noOp };

		const closeRuntime = () => {
			if (runtime.closed) return;
			runtime.closed = true;
			runtime.handle?.hide();
			if (overlayRuntime === runtime) overlayRuntime = { refresh: noOp, close: noOp };
			runtime.finish?.();
		};
		runtime.close = closeRuntime;
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new BtwOverlay(
						tui,
						theme,
						keybindings,
						(w, t) => getTranscriptLines(w, t),
						() => buildStatusText(),
						(value) => {
							void handleOverlaySubmit(value);
						},
						() => {
							void closeOverlayFlow(ctx);
						},
						() => {
							void cancelRequest();
						},
					);

					overlay.busy = sideBusy;
					overlay.focused = true;
					overlay.setDraft(overlayDraft);

					runtime.overlay = overlay;
					runtime.refresh = () => {
						overlay.busy = sideBusy;
						overlay.focused = runtime.handle?.isFocused() ?? false;
						tui.requestRender();
					};
					runtime.close = () => {
						overlayDraft = overlay.getDraft();
						closeRuntime();
					};

					if (runtime.closed) done();
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 72,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) closeRuntime();
					},
				},
			)
			.catch((error) => {
				if (overlayRuntime === runtime) overlayRuntime = { refresh: noOp, close: noOp };
				if (latestCtx?.hasUI) {
					latestCtx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"error",
					);
				}
			});
	}

	// ── Overlay submit / cancel ───────────────────────────────────────────────

	async function handleOverlaySubmit(rawValue: string): Promise<void> {
		const question = rawValue.trim();
		if (!question) {
			setStatus("Enter a question first.");
			return;
		}
		if (!latestCtx) {
			// Should not happen in practice — latestCtx is set before the overlay opens.
			setStatus("Use /btw to open the side chat first.");
			return;
		}
		await runBtwPrompt(latestCtx, question);
	}

	/**
	 * Abort the active in-flight request.
	 *
	 * Sets promptAborted so runBtwPrompt's catch block knows this is an
	 * intentional cancel, not an unexpected error. The overlay Esc hint
	 * already says "Esc cancel request" when busy, so no extra notification.
	 */
	async function cancelRequest(): Promise<void> {
		if (!sideBusy) return;
		promptAborted = true;
		thread.pendingError = "Cancelled.";
		setStatus("Cancelled.");
		overlayRuntime.overlay?.resetScroll();
		await sideSession.abort();
	}

	// ── Core: run a BTW prompt ────────────────────────────────────────────────

	/**
	 * Submit a question to the BTW side session and stream the response.
	 *
	 * Accepts ExtensionContext (not the command-only variant) because it never
	 * calls waitForIdle(). This is the key fix for the original context-capture
	 * bug: the overlay's onSubmit callback reads latestCtx from the closure,
	 * which is always a valid ExtensionContext regardless of how the overlay
	 * was opened.
	 */
	async function runBtwPrompt(ctx: ExtensionContext, question: string): Promise<void> {
		if (!ctx.model) {
			setStatus("No model selected.");
			notify(ctx, "BTW: no active model selected.", "error");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			setStatus(auth.error);
			notify(ctx, auth.error, "error");
			return;
		}

		if (sideBusy) {
			notify(ctx, "BTW is still processing the previous message.", "warning");
			return;
		}

		const btwModel = await getModelForSlot("btw", ctx);
		const session = await sideSession.ensure(
			ctx,
			thread,
			pi.getThinkingLevel() as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
			handleSideEvent,
			(msg) => notify(ctx, msg, "warning"),
			btwModel ?? undefined,
		);
		if (!session) {
			notify(ctx, "BTW: could not create side session.", "error");
			return;
		}

		sideBusy = true;
		promptAborted = false;
		thread.pendingQuestion = question;
		thread.pendingAnswer = "";
		thread.pendingError = null;
		thread.pendingToolCalls.length = 0;
		setStatus("Streaming response…");
		overlayRuntime.refresh();

		try {
			await session.prompt(question, { source: "extension" });

			// Check for user-initiated cancel first — message and status were
			// already set by cancelRequest(), so just return.
			if (promptAborted) return;

			const response = getLastAssistantMessage(session);
			if (!response || response.stopReason === "aborted") {
				// Aborted without an explicit cancel — treat as cancelled.
				thread.pendingError = "Cancelled.";
				setStatus("Cancelled.");
				return;
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "BTW request failed.");
			}

			const answer = extractAssistantText(response.content) || "(No text response)";
			const details: BtwDetails = {
				question,
				answer,
				timestamp: Date.now(),
				provider: ctx.model.provider,
				model: ctx.model.id,
				usage: response.usage,
			};
			thread.commitPending(details);
			pi.appendEntry(BTW_ENTRY_TYPE, details);
			setStatus("Ready");
			overlayRuntime.overlay?.resetScroll();
		} catch (error) {
			if (promptAborted) return; // Cancel already handled.
			const msg = error instanceof Error ? error.message : String(error);
			thread.pendingError = msg;
			setStatus("Request failed.");
			notify(ctx, msg, "error");
		} finally {
			promptAborted = false;
			sideBusy = false;
			overlayRuntime.refresh();
		}
	}

	// ── Summary & inject ──────────────────────────────────────────────────────

	/**
	 * Summarise the current thread using a single complete() call.
	 * The full AgentSession overhead is unnecessary for a one-shot prompt.
	 */
	async function summariseThread(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
		return summarise(ctx, thread.formatForSummary(), signal);
	}

	async function injectSummary(ctx: ExtensionContext): Promise<void> {
		if (thread.items.length === 0) {
			notify(ctx, "No BTW thread to summarise.", "warning");
			return;
		}

		// Show a spinner while the summary LLM call is in flight.
		// BorderedLoader provides a signal so the user can cancel with Esc.
		if (!ctx.hasUI) {
			// Non-interactive mode: run without UI.
			try {
				const summary = await summariseThread(ctx);
				const message = `Summary of my BTW side conversation:\n\n${summary}`;
				if (ctx.isIdle()) {
					pi.sendUserMessage(message);
				} else {
					pi.sendUserMessage(message, { deliverAs: "followUp" });
				}
				await resetThread(ctx, true);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				notify(ctx, msg, "error");
			}
			return;
		}

		const summary = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(
				tui,
				theme,
				`Summarising BTW thread (${thread.items.length} message${thread.items.length !== 1 ? "s" : ""})…`,
			);
			loader.onAbort = () => done(null);

			summariseThread(ctx, loader.signal)
				.then(done)
				.catch(() => done(null));

			return loader;
		});

		if (summary === null) {
			notify(ctx, "BTW summary cancelled.", "info");
			return;
		}

		try {
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}
			await resetThread(ctx, true);
			notify(ctx, "Injected BTW summary into main chat.", "info");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			notify(ctx, msg, "error");
		}
	}

	// ── Thread management ─────────────────────────────────────────────────────

	async function resetThread(ctx: ExtensionContext, persist = true): Promise<void> {
		thread.reset();
		sideBusy = false;
		promptAborted = false;
		overlayDraft = "";
		setStatus("Ready");
		overlayRuntime.overlay?.resetScroll();
		await sideSession.dispose();
		if (persist) {
			const details: BtwResetDetails = { timestamp: Date.now() };
			pi.appendEntry(BTW_RESET_TYPE, details);
		}
		overlayRuntime.refresh();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		await sideSession.dispose();
		thread.restore(ctx.sessionManager.getBranch());
		sideBusy = false;
		promptAborted = false;
		overlayStatus = "Ready";
		overlayDraft = "";
		overlayRuntime.overlay?.resetScroll();
		overlayRuntime.refresh();
	}

	// ── Close overlay flow ────────────────────────────────────────────────────

	async function closeOverlayFlow(ctx: ExtensionContext): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI || thread.items.length === 0) return;

		const choice = await ctx.ui.select("Close BTW:", [
			"Keep side thread",
			"Inject summary into main chat",
		]);
		if (choice === "Inject summary into main chat") {
			await injectSummary(ctx);
		}
	}

	// ── /btw command ──────────────────────────────────────────────────────────

	pi.registerCommand("btw", {
		description:
			"/btw [question] — open side chat or ask inline. " +
			"Subcommands: reset · inject · status",
		handler: async (args, ctx) => {
			// Always update latestCtx so overlay onSubmit has a fresh context.
			latestCtx = ctx;

			const sub = args.trim();

			// ── Subcommands ────────────────────────────────────────────────────
			if (sub === "reset") {
				await resetThread(ctx, true);
				notify(ctx, "BTW thread cleared.", "info");
				return;
			}

			if (sub === "inject") {
				await injectSummary(ctx);
				return;
			}

			if (sub === "status") {
				if (thread.isEmpty) {
					notify(ctx, "BTW: no messages yet.", "info");
				} else {
					const { input, output, cost } = thread.totalUsage();
					notify(
						ctx,
						`BTW: ${thread.items.length} message(s) · ↑${input} ↓${output} $${cost.toFixed(4)}`,
						"info",
					);
				}
				return;
			}

			// ── Inline question ────────────────────────────────────────────────
			if (sub) {
				await openOverlay(ctx);
				await runBtwPrompt(ctx, sub);
				return;
			}

			// ── No args: open overlay ──────────────────────────────────────────
			if (!thread.isEmpty && ctx.hasUI) {
				const choice = await ctx.ui.select("BTW side chat:", [
					"Continue previous conversation",
					"Start fresh",
				]);
				if (choice === "Start fresh") {
					await resetThread(ctx, true);
				} else if (choice === "Continue previous conversation") {
					// Recreate side session so it gets fresh main context on next submit.
					await sideSession.dispose();
					setStatus("Continuing BTW thread.");
				}
				// null = user cancelled (Esc) — fall through to openOverlay anyway.
			}
			await openOverlay(ctx);
		},
	});

	// ── Ctrl+B shortcut ───────────────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Open / focus BTW side chat",
		handler: async (ctx) => {
			latestCtx = ctx;
			await openOverlay(ctx);
		},
	});

	// ── Lifecycle events ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	/**
	 * When the model changes, dispose the side session so the next submit
	 * creates a fresh one using the new model. Thread items are preserved.
	 */
	pi.on("model_select", async () => {
		await sideSession.dispose();
	});

	pi.on("session_shutdown", async () => {
		await sideSession.dispose();
		dismissOverlay();
	});
}
