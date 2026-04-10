/**
 * Plan Tracker Extension
 *
 * Non-modal plan tracking that integrates naturally into conversations.
 * Detects plans from assistant messages, tracks execution progress,
 * and provides a work log on completion.
 *
 * Features:
 * - Auto-detection: regex pre-filter → small-model extraction
 * - /plan <msg>: request a plan from the AI (no mode switch)
 * - /track: manually extract plan from last message via LLM + TUI editor
 * - /todos: view current plan progress
 * - /done N: manually mark a step as complete
 * - mark_done tool: AI reports step completion with optional summary
 * - Ctrl+Alt+P: shortcut for /track
 * - Progress widget + footer status
 * - Work log on plan completion
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { extractPlan } from "./extract.js";
import { PlanEditorComponent, type PlanEditorResult } from "./plan-editor.js";
import {
	formatElapsed,
	getTextContent,
	isAssistantMessage,
	looksLikePlan,
	type PlanStep,
} from "./utils.js";

export default function planTrackerExtension(pi: ExtensionAPI): void {
	let steps: PlanStep[] = [];
	let planStartedAt = 0;
	let pauseOnStep = false;
	let skipConfirmations = false;

	// ── State persistence ──────────────────────────────────────────────────

	let lastPersisted = "";
	function persist(): void {
		const state = JSON.stringify({ steps, startedAt: planStartedAt });
		if (state === lastPersisted) return;
		lastPersisted = state;
		pi.appendEntry("plan-tracker", JSON.parse(state));
	}

	// ── UI updates ─────────────────────────────────────────────────────────

	function updateUI(ctx: ExtensionContext): void {
		if (steps.length === 0) {
			ctx.ui.setStatus("plan-tracker", undefined);
			ctx.ui.setWidget("plan-tracker", undefined);
			return;
		}

		const done = steps.filter((s) => s.completed).length;

		// Footer status
		ctx.ui.setStatus("plan-tracker", ctx.ui.theme.fg("accent", `📋 ${done}/${steps.length}`));

		// Widget
		const lines = steps.map((item) => {
			if (item.completed) {
				const check = ctx.ui.theme.fg("success", "☑ ");
				const text = ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
				const summary = item.summary ? ctx.ui.theme.fg("muted", ` → ${item.summary}`) : "";
				return check + text + summary;
			}
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
		});
		ctx.ui.setWidget("plan-tracker", lines);
	}

	// ── Activate plan ──────────────────────────────────────────────────────

	function activatePlan(newSteps: PlanStep[], pause: boolean, ctx: ExtensionContext): void {
		steps = newSteps;
		planStartedAt = Date.now();
		pauseOnStep = pause;
		skipConfirmations = !pause;
		updateUI(ctx);
		persist();
	}

	function clearPlan(ctx: ExtensionContext): void {
		steps = [];
		planStartedAt = 0;
		pauseOnStep = false;
		skipConfirmations = false;
		updateUI(ctx);
		persist();
	}

	// ── Build work log ─────────────────────────────────────────────────────

	function buildWorkLog(): string {
		const elapsed = formatElapsed(Date.now() - planStartedAt);
		const header = `📋 Plan Complete (${steps.length}/${steps.length}) — ${elapsed}`;
		const lines = steps.map((s) => {
			const summary = s.summary ? ` → ${s.summary}` : "";
			return ` ${s.step}. ✓ ${s.text}${summary}`;
		});
		return `**${header}**\n\n${lines.join("\n")}`;
	}

	// ── Offer tracking after extraction ────────────────────────────────────

	async function offerTracking(extracted: PlanStep[], ctx: ExtensionContext): Promise<void> {
		const choice = await ctx.ui.select(
			`检测到计划（${extracted.length} 步），如何执行？`,
			["逐步执行（每步暂停确认）", "一次性运行全部", "只追踪（手动 /done）", "忽略"],
		);
		if (!choice || choice === "忽略") return;

		const pause = choice.startsWith("逐步");
		const trackOnly = choice.startsWith("只追踪");
		activatePlan(extracted, pause, ctx);

		if (!trackOnly) {
			const first = steps[0];
			pi.sendMessage(
				{
					customType: "plan-tracker-execute",
					content: `Execute the plan. Start with step ${first.step}: ${first.detail}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
	}

	// ── Find last assistant text on branch ─────────────────────────────────

	function findLastAssistantText(ctx: ExtensionContext): string | null {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			const msg = entry.message as AgentMessage;
			if (!isAssistantMessage(msg)) continue;
			return getTextContent(msg);
		}
		return null;
	}

	// ── mark_done tool (always available) ──────────────────────────────────

	pi.registerTool({
		name: "mark_done",
		label: "Mark Step Done",
		description: "Mark a plan step as completed. Call this immediately after finishing each step during plan execution.",
		promptSnippet: "mark_done(step) - report a plan step as completed",
		promptGuidelines: [
			"Only call mark_done when there is an active tracked plan. If no plan is being tracked, ignore this tool.",
		],
		parameters: Type.Object({
			step: Type.Number({ description: "The step number to mark as completed" }),
			summary: Type.Optional(Type.String({ description: "Brief summary of what was accomplished (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (steps.length === 0) {
				return {
					content: [{ type: "text", text: "No plan is currently being tracked." }],
					details: { success: false },
				};
			}

			const item = steps.find((t) => t.step === params.step);
			if (!item) {
				return {
					content: [{ type: "text", text: `Step ${params.step} not found in current plan.` }],
					details: { success: false },
				};
			}
			if (item.completed) {
				return {
					content: [{ type: "text", text: `Step ${params.step} is already marked complete.` }],
					details: { success: true, step: params.step, alreadyDone: true },
				};
			}

			item.completed = true;
			item.completedAt = Date.now();
			if (params.summary) item.summary = params.summary;
			updateUI(ctx);
			persist();

			const message = params.summary
				? `✓ Step ${params.step} complete: ${params.summary}`
				: `✓ Step ${params.step} marked complete.`;

			// Check for plan completion
			if (steps.every((s) => s.completed)) {
				const log = buildWorkLog();
				pi.sendMessage(
					{ customType: "plan-tracker-complete", content: log, display: true },
					{ triggerTurn: false },
				);
				clearPlan(ctx);
				return {
					content: [{ type: "text", text: `${message}\n\nAll steps complete!` }],
					details: { success: true, step: params.step, planComplete: true },
				};
			}

			// Pause for confirmation if step-by-step
			const remaining = steps.filter((s) => !s.completed);
			if (remaining.length > 0 && !skipConfirmations && pauseOnStep) {
				const nextStep = remaining[0];
				const choice = await ctx.ui.select(
					`${message}\n\nNext: Step ${nextStep.step} — ${nextStep.text}`,
					["Continue", "Run all remaining", "Stop here", "Give feedback"],
				);
				if (choice === "Run all remaining") {
					skipConfirmations = true;
				} else if (choice === "Stop here") {
					ctx.abort();
					return {
						content: [{ type: "text", text: `${message}\n\nExecution paused by user.` }],
						details: { success: true, step: params.step, paused: true },
					};
				} else if (choice === "Give feedback") {
					const feedback = await ctx.ui.input("Feedback for next step:");
					const feedbackText = feedback?.trim() ? `\nUser feedback: ${feedback.trim()}` : "";
					return {
						content: [{ type: "text", text: `${message}${feedbackText}` }],
						details: { success: true, step: params.step },
					};
				}
			}

			return {
				content: [{ type: "text", text: message }],
				details: { success: true, step: params.step },
			};
		},
	});

	// ── /plan command ──────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Request a plan: /plan <message>",
		handler: async (args, ctx) => {
			const message = args?.trim();
			if (!message) {
				ctx.ui.notify("Usage: /plan <message>  — e.g. /plan 重构登录模块", "info");
				return;
			}
			pi.sendUserMessage(`请分析以下任务并制定详细的编号执行计划：\n\n${message}`);
		},
	});

	// ── /track command ─────────────────────────────────────────────────────

	pi.registerCommand("track", {
		description: "Extract and track plan from last assistant message",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/track requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const assistantText = findLastAssistantText(ctx);
			if (!assistantText) {
				ctx.ui.notify("No assistant message found", "error");
				return;
			}

			const extracted = await extractPlan(
				assistantText,
				ctx,
				ctx.ui,
			);

			if (extracted === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (extracted.length === 0) {
				ctx.ui.notify("No actionable plan found in last message", "info");
				return;
			}

			// Show PlanEditor TUI
			const editorResult = await ctx.ui.custom<PlanEditorResult>((tui, _theme, _kb, done) => {
				return new PlanEditorComponent(extracted, done);
			});

			if (editorResult.cancelled || editorResult.steps.length === 0) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await offerTracking(editorResult.steps, ctx);
		},
	});

	// ── /todos command ─────────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (steps.length === 0) {
				ctx.ui.notify("No active plan. Use /plan <msg> to request one, or /track to extract from last message.", "info");
				return;
			}
			const done = steps.filter((s) => s.completed).length;
			const elapsed = formatElapsed(Date.now() - planStartedAt);
			const list = steps
				.map((s) => {
					const check = s.completed ? "✓" : "○";
					const summary = s.completed && s.summary ? ` → ${s.summary}` : "";
					return `  ${s.step}. ${check} ${s.text}${summary}`;
				})
				.join("\n");
			ctx.ui.notify(`Plan Progress (${done}/${steps.length}) — ${elapsed}\n\n${list}`, "info");
		},
	});

	// ── /done command ──────────────────────────────────────────────────────

	pi.registerCommand("done", {
		description: "Manually mark a plan step as complete: /done <step>",
		handler: async (args, ctx) => {
			if (steps.length === 0) {
				ctx.ui.notify("No active plan.", "info");
				return;
			}
			const n = parseInt(args?.trim() ?? "", 10);
			if (isNaN(n) || n < 1) {
				ctx.ui.notify("Usage: /done <step number>", "error");
				return;
			}
			const item = steps.find((s) => s.step === n);
			if (!item) {
				ctx.ui.notify(`Step ${n} not found.`, "error");
				return;
			}
			if (item.completed) {
				ctx.ui.notify(`Step ${n} is already complete.`, "info");
				return;
			}
			item.completed = true;
			item.completedAt = Date.now();
			updateUI(ctx);
			persist();
			ctx.ui.notify(`✓ Step ${n} marked complete.`, "info");

			// Check for plan completion
			if (steps.every((s) => s.completed)) {
				const log = buildWorkLog();
				pi.sendMessage(
					{ customType: "plan-tracker-complete", content: log, display: true },
					{ triggerTurn: false },
				);
				clearPlan(ctx);
			}
		},
	});

	// ── Shortcut: Ctrl+Alt+P → /track ──────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Extract and track plan from last message",
		handler: async (ctx) => {
			if (!ctx.hasUI || !ctx.model) return;

			const assistantText = findLastAssistantText(ctx);
			if (!assistantText) {
				ctx.ui.notify("No assistant message found", "error");
				return;
			}

			const extracted = await extractPlan(
				assistantText,
				ctx,
				ctx.ui,
			);

			if (extracted === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (extracted.length === 0) {
				ctx.ui.notify("No actionable plan found in last message", "info");
				return;
			}

			const editorResult = await ctx.ui.custom<PlanEditorResult>((tui, _theme, _kb, done) => {
				return new PlanEditorComponent(extracted, done);
			});

			if (editorResult.cancelled || editorResult.steps.length === 0) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await offerTracking(editorResult.steps, ctx);
		},
	});

	// ── Context injection ──────────────────────────────────────────────────

	pi.on("before_agent_start", async () => {
		if (steps.length === 0) return;

		const remaining = steps.filter((s) => !s.completed);
		if (remaining.length === 0) return;

		const done = steps.filter((s) => s.completed).length;
		const current = remaining[0];
		const next = remaining.length > 1 ? remaining[1] : null;

		let content = `[Plan Progress: ${done}/${steps.length} complete]\n`;
		content += `Current: Step ${current.step} — ${current.detail}\n`;
		if (next) content += `Next: Step ${next.step} — ${next.detail}\n`;
		content += `\nAfter completing each step, call mark_done(step) with a brief summary.`;

		return {
			message: {
				customType: "plan-tracker-context",
				content,
				display: false,
			},
		};
	});

	// ── Auto-detection on agent_end ────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		// Skip if there's already an active plan
		if (steps.length > 0) return;
		if (!ctx.hasUI || !ctx.model) return;

		// Find the last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;
		const text = getTextContent(lastAssistant as AssistantMessage);

		// Pre-filter: cheap regex check
		if (!looksLikePlan(text)) return;

		// Extract via small model
		const extracted = await extractPlan(
			text,
			ctx,
			ctx.ui,
		);

		if (!extracted || extracted.length === 0) return;

		await offerTracking(extracted, ctx);
	});

	// ── Filter stale context messages ──────────────────────────────────────

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-tracker-context" && steps.length === 0) return false;
				return true;
			}),
		};
	});

	// ── Session restore ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		// Find the last plan-tracker state entry
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-tracker")
			.pop() as { data?: { steps?: PlanStep[]; startedAt?: number } } | undefined;

		if (stateEntry?.data?.steps && stateEntry.data.steps.length > 0) {
			steps = stateEntry.data.steps;
			planStartedAt = stateEntry.data.startedAt ?? Date.now();
			// Always start fresh — user re-chooses execution mode
			pauseOnStep = false;
			skipConfirmations = false;
		}

		updateUI(ctx);
	});
}
