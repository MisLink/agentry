/**
 * Plan Tracker Extension
 *
 * Non-modal plan tracking that integrates naturally into conversations.
 * The AI creates plans via the `create_plan` tool, the user tracks progress
 * via widget + mark_done.
 *
 * Features:
 * - create_plan tool: AI outputs structured plan steps directly (zero extra cost)
 * - mark_done tool: AI reports step completion with optional summary
 * - /plan <msg>: request a plan from the AI
 * - /track: manually create/edit a plan via PlanEditor TUI
 * - /todos: view current plan progress
 * - /done N: manually mark a step as complete
 * - Ctrl+Alt+P: shortcut for /track
 * - Progress widget + footer status
 * - Work log on plan completion
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatElapsed, type PlanStep } from "./utils.js";

export default function planTrackerExtension(pi: ExtensionAPI): void {
	let steps: PlanStep[] = [];
	let planStartedAt = 0;
	let pauseOnStep = false;
	let skipConfirmations = false;
	let pendingRefine = false;

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
		ctx.ui.setStatus("plan-tracker", ctx.ui.theme.fg("accent", `📋 ${done}/${steps.length}`));

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

	// ── Plan lifecycle ─────────────────────────────────────────────────────

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

	function buildWorkLog(): string {
		const elapsed = formatElapsed(Date.now() - planStartedAt);
		const header = `📋 Plan Complete (${steps.length}/${steps.length}) — ${elapsed}`;
		const lines = steps.map((s) => {
			const summary = s.summary ? ` → ${s.summary}` : "";
			return ` ${s.step}. ✓ ${s.text}${summary}`;
		});
		return `**${header}**\n\n${lines.join("\n")}`;
	}

	// ── Offer tracking mode selection ──────────────────────────────────────

	type TrackingChoice = "execute" | "track-only" | "refine" | "ignore";

	/** User feedback collected during the input phase, available after offerTracking returns "refine". */
	let lastRefineFeedback = "";

	async function offerTracking(planSteps: PlanStep[], isRefine: boolean, ctx: ExtensionContext): Promise<TrackingChoice> {
		const planList = planSteps.map((s) => `  ${s.step}. ${s.text}`).join("\n");

		// Step 1: Show input field for optional feedback
		const inputPrompt = isRefine
			? `修改后的计划（${planSteps.length} 步）：\n${planList}\n\n还要补充什么？（直接回车跳过）`
			: `计划（${planSteps.length} 步）：\n${planList}\n\n要补充什么？（直接回车跳过）`;
		const feedback = await ctx.ui.input(inputPrompt);
		if (feedback?.trim()) {
			lastRefineFeedback = feedback.trim();
			return "refine";
		}

		// Step 2: No feedback — pick execution mode
		const options = isRefine
			? ["逐步执行（每步暂停确认）", "一次性运行全部", "忽略"]
			: ["逐步执行（每步暂停确认）", "一次性运行全部", "只追踪（手动 /done）", "忽略"];
		const choice = await ctx.ui.select("如何执行？", options);
		if (!choice || choice === "忽略") return "ignore";

		const pause = choice.startsWith("逐步");
		const trackOnly = choice.startsWith("只追踪");
		activatePlan(planSteps, pause, ctx);

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
			return "execute";
		}
		return "track-only";
	}

	// ── create_plan tool ───────────────────────────────────────────────────

	pi.registerTool({
		name: "create_plan",
		label: "Create Plan",
		description:
			"Create a tracked execution plan. The plan appears as a progress widget " +
			"and enables mark_done for step-by-step tracking. Call this when you've " +
			"analyzed a task and are ready to propose a concrete sequence of steps.",
		promptSnippet: "create_plan({ steps }) - create a tracked execution plan with numbered steps",
		promptGuidelines: [
			"When you formulate a multi-step plan for a task, call create_plan to register it for tracking instead of just describing the steps in text.",
			"Each step should have a short 'text' (≤60 chars, for the progress widget) and a detailed 'detail' (full description for execution context).",
			"Only call create_plan when you have a concrete plan ready to execute. Do not call it for brainstorming or listing options.",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					text: Type.String({ description: "Short step summary (≤60 chars) for the progress widget" }),
					detail: Type.String({ description: "Full step description with enough context to execute" }),
				}),
				{ description: "Ordered list of plan steps", minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planSteps: PlanStep[] = params.steps.map((s, i) => ({
				step: i + 1,
				text: s.text.slice(0, 60),
				detail: s.detail,
				completed: false,
			}));

			const isRefine = pendingRefine;
			pendingRefine = false;
			const choice = await offerTracking(planSteps, isRefine, ctx);

			if (choice === "refine") {
				pendingRefine = true;
				const list = planSteps.map((s) => `${s.step}. ${s.text} — ${s.detail}`).join("\n");
				const feedback = lastRefineFeedback;
				lastRefineFeedback = "";
				return {
					content: [{ type: "text", text: `User wants to refine the plan before starting. Current draft:\n${list}\n\nUser feedback: ${feedback}\n\nRevise the plan based on this feedback, then call create_plan again with the revised steps.` }],
					details: { success: false, reason: "refine" },
				};
			}

			if (steps.length > 0) {
				const list = steps.map((s) => `${s.step}. ${s.text}`).join("\n");
				return {
					content: [{ type: "text", text: `Plan created (${steps.length} steps):\n${list}` }],
					details: { success: true, stepCount: steps.length },
				};
			}

			return {
				content: [{ type: "text", text: "Plan was not activated (user chose to ignore)." }],
				details: { success: false },
			};
		},
	});

	// ── mark_done tool ─────────────────────────────────────────────────────

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
			pi.sendUserMessage(`请分析以下任务并制定执行计划，使用 create_plan 工具输出：\n\n${message}`);
		},
	});

	// ── /todos command ─────────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (steps.length === 0) {
				ctx.ui.notify("No active plan. Ask the AI to create one, or use /track to create manually.", "info");
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

		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-tracker")
			.pop() as { data?: { steps?: PlanStep[]; startedAt?: number } } | undefined;

		if (stateEntry?.data?.steps && stateEntry.data.steps.length > 0) {
			steps = stateEntry.data.steps;
			planStartedAt = stateEntry.data.startedAt ?? Date.now();
			pauseOnStep = false;
			skipConfirmations = false;
		}

		updateUI(ctx);
	});
}
