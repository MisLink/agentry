/**
 * Plan Tracker Extension
 *
 * Non-modal plan tracking that integrates naturally into conversations.
 * The AI creates plans via the `create_plan` tool, the user tracks progress
 * via widget + mark_done.
 *
 * Features:
 * - create_plan tool: AI outputs a structured plan draft
 * - mark_done tool: AI reports step completion with optional summary
 * - /plan <msg>: request a plan draft from the AI
 * - /plan track: start manual progress tracking from the current draft
 * - /plan run: run the current draft or tracked plan automatically
 * - /plan status: view current draft or plan progress
 * - /plan done N: manually mark a step as complete
 * - Progress widget + footer status
 * - Work log on plan completion
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { filterPlanTrackerContextMessages, parsePlanCommand, shouldQueueNextStepAfterCompletion, type PlanExecutionMode, type PlanStepDraft } from "./logic.js";
import { formatElapsed, type PlanStep } from "./utils.js";

export default function planTrackerExtension(pi: ExtensionAPI): void {
	let draftSteps: PlanStep[] = [];
	let steps: PlanStep[] = [];
	let planMode: PlanExecutionMode | undefined;
	let planStartedAt = 0;
	let pendingPlanActivation: PlanExecutionMode | undefined;

	// ── State persistence ──────────────────────────────────────────────────

	let lastPersisted = "";
	function persist(): void {
		const state = JSON.stringify({ draftSteps, steps, startedAt: planStartedAt, mode: planMode });
		if (state === lastPersisted) return;
		lastPersisted = state;
		pi.appendEntry("plan-tracker", JSON.parse(state));
	}

	// ── UI updates ─────────────────────────────────────────────────────────

	function updateUI(ctx: ExtensionContext): void {
		if (steps.length === 0) {
			ctx.ui.setStatus(
				"plan-tracker",
				draftSteps.length > 0 ? ctx.ui.theme.fg("accent", `📝 ${draftSteps.length}`) : undefined,
			);
			ctx.ui.setWidget("plan-tracker", undefined);
			return;
		}

		const done = steps.filter((s) => s.completed).length;
		const icon = planMode === "running" ? "▶" : "📋";
		ctx.ui.setStatus("plan-tracker", ctx.ui.theme.fg("accent", `${icon} ${done}/${steps.length}`));

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

	// ── Plan helpers ───────────────────────────────────────────────────────

	function getRemainingSteps(): PlanStep[] {
		return steps.filter((step) => !step.completed);
	}

	function getCurrentStep(): PlanStep | undefined {
		return getRemainingSteps()[0];
	}

	function setDraft(newSteps: PlanStep[], ctx: ExtensionContext): void {
		draftSteps = newSteps;
		updateUI(ctx);
		persist();
	}

	function setPlan(newSteps: PlanStep[], ctx: ExtensionContext): void {
		steps = newSteps;
		updateUI(ctx);
		persist();
	}

	function queueExecution(step: PlanStep, feedback?: string): void {
		let content = `Continue the running plan. Execute step ${step.step}: ${step.detail}`;
		if (feedback) {
			content += `\n\nUser feedback for this step: ${feedback}`;
		}
		pi.sendMessage(
			{
				customType: "plan-tracker-execute",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	function clonePlanSteps(source: readonly PlanStep[], preserveCompletion: boolean): PlanStep[] {
		return source.map((step, index) => ({
			step: index + 1,
			text: step.text,
			detail: step.detail,
			completed: preserveCompletion ? step.completed : false,
			summary: preserveCompletion ? step.summary : undefined,
			completedAt: preserveCompletion ? step.completedAt : undefined,
		}));
	}

	function activatePlan(newSteps: PlanStep[], mode: PlanExecutionMode, ctx: ExtensionContext): void {
		planStartedAt = Date.now();
		planMode = mode;
		draftSteps = [];
		setPlan(clonePlanSteps(newSteps, false), ctx);
	}

	function clearPlan(ctx: ExtensionContext): void {
		draftSteps = [];
		steps = [];
		planStartedAt = 0;
		planMode = undefined;
		pendingPlanActivation = undefined;
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

	function buildPlanDrafts(inputSteps: { text: string; detail: string }[]): PlanStepDraft[] {
		return inputSteps.map((step) => ({
			text: step.text.slice(0, 60),
			detail: step.detail,
		}));
	}

	function materializePlanSteps(drafts: readonly PlanStepDraft[]): PlanStep[] {
		return drafts.map((step, index) => ({
			step: index + 1,
			text: step.text.slice(0, 60),
			detail: step.detail,
			completed: false,
		}));
	}

	function formatPlanList(planSteps: readonly PlanStep[], includeDetail = false): string {
		return planSteps
			.map((step) => {
				const detail = includeDetail ? ` — ${step.detail}` : "";
				return `${step.step}. ${step.text}${detail}`;
			})
			.join("\n");
	}

	function requestPlanDraft(prompt: string | undefined, activation: PlanExecutionMode | undefined): void {
		pendingPlanActivation = activation;
		const feedback = prompt?.trim();
		const basePlan = draftSteps.length > 0 ? draftSteps : steps;
		const shouldReviseExisting = !!feedback && activation === undefined && basePlan.length > 0;

		let target: string;
		if (shouldReviseExisting) {
			target = `请根据反馈修订当前计划，并使用 create_plan 工具输出新的结构化步骤。\n\n当前计划：\n${formatPlanList(basePlan, true)}\n\n反馈：${feedback}`;
		} else if (feedback) {
			target = `针对以下任务生成一个可编辑的计划草案：\n\n${feedback}`;
		} else {
			target = "请基于当前对话上下文，总结一个可编辑的计划草案。";
		}

		const activationInstruction = activation === "running"
			? "\n\n用户明确要求生成计划后直接执行。请先调用 create_plan 输出草案；插件会在草案创建后自动进入 run。"
			: "\n\n只创建草案，不要开始执行。";
		pi.sendUserMessage(`${target}${activationInstruction}\n\n请使用 create_plan 工具输出结构化步骤。`);
	}

	function startPlan(mode: PlanExecutionMode, ctx: ExtensionContext): boolean {
		const wasRunning = steps.length > 0 && draftSteps.length === 0 && planMode === "running";
		if (draftSteps.length > 0) {
			activatePlan(draftSteps, mode, ctx);
		} else if (steps.length > 0) {
			planMode = mode;
			updateUI(ctx);
			persist();
		} else {
			return false;
		}

		if (mode === "running" && !wasRunning) {
			const current = getCurrentStep();
			if (!current) {
				throw new Error("Cannot run a plan without a pending step");
			}
			queueExecution(current);
		}
		return true;
	}

	function describeCurrentPlan(): string {
		const parts: string[] = [];
		if (steps.length > 0) {
			const done = steps.filter((step) => step.completed).length;
			const elapsed = formatElapsed(Date.now() - planStartedAt);
			const mode = planMode === "running" ? "running" : "tracked";
			const list = steps
				.map((step) => {
					const check = step.completed ? "✓" : "○";
					const summary = step.completed && step.summary ? ` → ${step.summary}` : "";
					return `  ${step.step}. ${check} ${step.text}${summary}`;
				})
				.join("\n");
			parts.push(`Plan ${mode} (${done}/${steps.length}) — ${elapsed}\n\n${list}`);
		}
		if (draftSteps.length > 0) {
			parts.push(`Plan draft (${draftSteps.length} steps)\n\n${formatPlanList(draftSteps)}`);
		}
		return parts.join("\n\n");
	}

	function completeStep(stepNumber: number, summary: string | undefined, ctx: ExtensionContext) {
		if (steps.length === 0) {
			return { content: "No plan is currently being tracked.", details: { success: false } };
		}
		if (Number.isNaN(stepNumber) || stepNumber < 1) {
			return { content: "Usage: /plan done <step number>", details: { success: false } };
		}

		const item = steps.find((step) => step.step === stepNumber);
		if (!item) {
			return { content: `Step ${stepNumber} not found in current plan.`, details: { success: false } };
		}
		if (item.completed) {
			return { content: `Step ${stepNumber} is already marked complete.`, details: { success: true, step: stepNumber, alreadyDone: true } };
		}

		item.completed = true;
		item.completedAt = Date.now();
		if (summary) item.summary = summary;
		updateUI(ctx);
		persist();

		const message = summary
			? `✓ Step ${stepNumber} complete: ${summary}`
			: `✓ Step ${stepNumber} marked complete.`;

		if (steps.every((step) => step.completed)) {
			const log = buildWorkLog();
			pi.sendMessage(
				{ customType: "plan-tracker-complete", content: log, display: true },
				{ triggerTurn: false },
			);
			clearPlan(ctx);
			return { content: `${message}\n\nAll steps complete!`, details: { success: true, step: stepNumber, planComplete: true } };
		}

		const nextStep = getCurrentStep();
		if (!nextStep) throw new Error("Plan is missing the next pending step after mark_done");
		if (!planMode) throw new Error("Tracked plan is missing its execution mode");

		if (!shouldQueueNextStepAfterCompletion(planMode)) {
			return {
				content: `${message}\n\nNext tracked step: ${nextStep.step}. ${nextStep.text}`,
				details: { success: true, step: stepNumber, nextStep: nextStep.step, queued: false },
			};
		}

		queueExecution(nextStep);
		return {
			content: `${message}\n\nQueued step ${nextStep.step}.`,
			details: { success: true, step: stepNumber, nextStep: nextStep.step, queued: true },
		};
	}

	// ── create_plan tool ───────────────────────────────────────────────────

	pi.registerTool({
		name: "create_plan",
		label: "Create Plan Draft",
		description:
			"Create or update a draft plan only when the user explicitly asks for a plan, " +
			"or when the task is non-trivial, spans multiple dependent steps, and clearly benefits from planning.",
		promptSnippet: "create_plan({ steps }) - create a draft plan for non-trivial, multi-step work",
		promptGuidelines: [
			"Only call create_plan when the user explicitly asks for a plan, or when the task is non-trivial, spans multiple dependent steps, and would benefit from planning.",
			"Do not use create_plan for small fixes, single-file edits, routine questions, simple code reading, or straightforward execution.",
			"Each step should have a short 'text' (≤60 chars, for display) and a detailed 'detail' (full description with enough context to execute).",
			"Calling create_plan only creates a draft. It does not start tracking and does not run the plan. The user must explicitly choose /plan track or /plan run.",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					text: Type.String({ description: "Short step summary (≤60 chars) for display" }),
					detail: Type.String({ description: "Full step description with enough context to execute" }),
				}),
				{ description: "Ordered list of plan steps", minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const drafts = buildPlanDrafts(params.steps);
			const activation = pendingPlanActivation;
			pendingPlanActivation = undefined;

			const planSteps = materializePlanSteps(drafts);
			setDraft(planSteps, ctx);

			if (activation) {
				startPlan(activation, ctx);
				const modeText = activation === "running" ? "running" : "tracked";
				return {
					content: [{ type: "text", text: `Plan draft created and ${modeText}.\n\n${formatPlanList(steps)}` }],
					details: { success: true, mode: activation, stepCount: steps.length },
				};
			}

			const activeText = steps.length > 0 ? "\n\nActive tracked plan unchanged. Use /plan track or /plan run to replace it with this draft." : "\n\nUse /plan track to track it or /plan run to execute it.";
			return {
				content: [{ type: "text", text: `Plan draft created (${draftSteps.length} steps):\n${formatPlanList(draftSteps)}${activeText}` }],
				details: { success: true, draft: true, stepCount: draftSteps.length },
			};
		},
	});

	// ── mark_done tool ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "mark_done",
		label: "Mark Step Done",
		description: "Mark a tracked plan step as completed. Call this immediately after finishing the current tracked or running step.",
		promptSnippet: "mark_done(step) - report a plan step as completed",
		promptGuidelines: [
			"Only call mark_done when there is an active tracked plan. If no plan is being tracked, ignore this tool.",
			"mark_done updates progress only. In tracked mode, stop after the requested step unless the user explicitly asks to continue. In running mode, the extension queues the next step.",
		],
		parameters: Type.Object({
			step: Type.Number({ description: "The step number to mark as completed" }),
			summary: Type.Optional(Type.String({ description: "Brief summary of what was accomplished (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = completeStep(params.step, params.summary, ctx);
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
			};
		},
	});

	// ── /plan command ──────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Manage plan drafts: /plan [task or feedback], /plan track, /plan run [task], /plan done <step>, /plan clear",
		handler: async (args, ctx) => {
			const command = parsePlanCommand(args);
			if (command.action === "draft") {
				requestPlanDraft(command.prompt, undefined);
				return;
			}
			if (command.action === "track") {
				if (!startPlan("tracked", ctx)) {
					ctx.ui.notify("No plan draft or active plan to track. Use /plan <task> first.", "info");
					return;
				}
				ctx.ui.notify("Plan is now tracked. Progress will update, but steps will not auto-run.", "info");
				return;
			}
			if (command.action === "run") {
				if (command.prompt) {
					requestPlanDraft(command.prompt, "running");
					return;
				}
				if (!startPlan("running", ctx)) {
					ctx.ui.notify("No plan draft or active plan to run. Use /plan run <task> or /plan <task> first.", "info");
				}
				return;
			}
			if (command.action === "done") {
				const result = completeStep(command.step, undefined, ctx);
				ctx.ui.notify(result.content, result.details.success ? "info" : "error");
				return;
			}
			if (command.action === "clear") {
				clearPlan(ctx);
				ctx.ui.notify("Plan draft and tracked plan cleared.", "info");
				return;
			}
			if (command.action === "status") {
				const description = describeCurrentPlan();
				ctx.ui.notify(description || "No plan draft or active plan.", "info");
			}
		},
	});

	// ── Context injection ──────────────────────────────────────────────────

	pi.on("before_agent_start", async (_event) => {
		if (steps.length === 0) return;
		if (!planMode) {
			throw new Error("Tracked plan is missing its execution mode");
		}

		const remaining = getRemainingSteps();
		if (remaining.length === 0) return;

		const done = steps.filter((step) => step.completed).length;
		const current = remaining[0];
		const next = remaining.length > 1 ? remaining[1] : null;

		let content = `[Plan Mode: ${planMode}; ${done}/${steps.length} complete]\n`;
		content += `Current: Step ${current.step} — ${current.detail}\n`;
		if (next) content += `Next: Step ${next.step} — ${next.detail}\n`;
		content += "\nAfter completing each step, call mark_done(step) with a brief summary.";
		content += planMode === "running"
			? " The extension will queue the next step after mark_done."
			: " This is tracked manual mode; stop after the requested step unless the user explicitly asks to continue.";
		content += " Do not create a new plan for routine substeps while this plan is active.";

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
			messages: filterPlanTrackerContextMessages(event.messages as (AgentMessage & { customType?: string })[], steps.length > 0),
		};
	});

	pi.on("agent_end", async () => {
		pendingPlanActivation = undefined;
	});

	// ── Session restore ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		const stateEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "plan-tracker")
			.pop() as { data?: { draftSteps?: PlanStep[]; steps?: PlanStep[]; startedAt?: number; mode?: PlanExecutionMode } } | undefined;

		if (stateEntry?.data) {
			draftSteps = stateEntry.data.draftSteps ?? [];
			if (stateEntry.data.steps && stateEntry.data.steps.length > 0) {
				steps = stateEntry.data.steps;
				planStartedAt = stateEntry.data.startedAt ?? Date.now();
				planMode = stateEntry.data.mode === "running" ? "tracked" : stateEntry.data.mode ?? "tracked";
			}
		}

		updateUI(ctx);
	});
}
