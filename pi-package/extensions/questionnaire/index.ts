/**
 * Questionnaire Tool — Interactive question/answer with single-select,
 * multi-select, inline custom input, number shortcuts, and wizard flow.
 *
 * Single question: shows options, user picks one (or types), done.
 * Multiple questions: tab-based wizard, review + confirm at end.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { QuestionnaireComponent } from "./component.js";
import type { Answer, Question, QuestionnaireResult } from "./types.js";

// ── Schema ─────────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({ description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)" }),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow typing a custom answer (default: true)" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
	defaultValue: Type.Optional(Type.String({ description: "Pre-select the option matching this value" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ── Helpers ────────────────────────────────────────────────────────────────

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

function formatAnswerLine(q: Question, a: Answer): string {
	if (a.wasCustom) {
		return `${q.label}: user wrote: ${a.label}`;
	}
	const indices = a.indices?.join(", ") ?? "";
	return `${q.label}: user selected: ${indices}. ${a.label}`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. " +
			"Supports single-select, multi-select, and free-text input. " +
			"PREFER this tool over making assumptions when the user's intent is ambiguous.",
		promptSnippet:
			"questionnaire({ questions }) - Ask the user one or more questions with options. Use for clarifying requirements, getting preferences, or confirming decisions. Supports single-select, multi-select, and free-text answers.",
		promptGuidelines: [
			"When the user's request is ambiguous or underspecified, use the questionnaire tool to ask clarifying questions BEFORE proceeding. Do not guess.",
			"For decisions with 2+ viable options (tech choices, architecture, naming, scope), present them via questionnaire rather than picking one silently.",
			"For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		],
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
				multiSelect: q.multiSelect === true,
			}));

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				return new QuestionnaireComponent(questions, tui, theme, done);
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const q = questions.find((q) => q.id === a.id);
				return q ? formatAnswerLine(q, a) : `${a.id}: ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const prefix = a.wasCustom ? theme.fg("muted", "(wrote) ") : "";
				const display = !a.wasCustom && a.indices ? `${a.indices.join(", ")}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${prefix}${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
