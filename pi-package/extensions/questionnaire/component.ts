/**
 * QuestionnaireComponent — Interactive TUI for answering questions.
 *
 * Supports:
 * - Single / multi-question flows
 * - Single-select (number keys or ↑↓ + Enter)
 * - Multi-select (Space to toggle, Enter to confirm)
 * - Inline "other" input (type directly, no mode switch)
 * - Default values (pre-highlight an option)
 * - Wizard-style: auto-advance, review + confirm at end
 */

import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@mariozechner/pi-tui";
import { type Theme } from "@mariozechner/pi-coding-agent";
import type { Answer, Question, QuestionnaireResult } from "./types.js";

export class QuestionnaireComponent implements Component {
	private questions: Question[];
	private isMulti: boolean;
	private answers = new Map<string, Answer>();
	private currentTab = 0;
	private optionIndex = 0;
	private selectedSet = new Set<number>(); // for multi-select
	private inputActive = false;
	private supplementing = false;
	private showReview = false;

	/** Total number of navigable items for the current question (options + "Other" if allowOther). */
	private get totalItems(): number {
		const q = this.currentQuestion();
		if (!q) return 0;
		return q.options.length + (q.allowOther ? 1 : 0);
	}

	/** Whether the cursor is on the "Other" virtual item. */
	private get onOtherItem(): boolean {
		const q = this.currentQuestion();
		return !!q?.allowOther && this.optionIndex === q.options.length;
	}

	private editor: Editor;
	private tui: TUI;
	private theme: Theme;
	private onDone: (result: QuestionnaireResult) => void;

	// Render cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		questions: Question[],
		tui: TUI,
		theme: Theme,
		onDone: (result: QuestionnaireResult) => void,
	) {
		this.questions = questions;
		this.isMulti = questions.length > 1;
		this.tui = tui;
		this.theme = theme;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => this.requestRender();

		// Apply default value: pre-highlight the matching option
		this.applyDefault();
	}

	private applyDefault(): void {
		const q = this.currentQuestion();
		if (!q?.defaultValue) return;
		const idx = q.options.findIndex((o) => o.value === q.defaultValue);
		if (idx >= 0) this.optionIndex = idx;
	}

	private requestRender(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private currentQuestion(): Question | undefined {
		return this.questions[this.currentTab];
	}

	private allAnswered(): boolean {
		return this.questions.every((q) => this.answers.has(q.id));
	}

	private currentQuestionAnswered(): boolean {
		const q = this.currentQuestion();
		return !!q && this.answers.has(q.id);
	}

	private restoreSelectionState(): void {
		const q = this.currentQuestion();
		if (!q) return;

		this.optionIndex = 0;
		this.selectedSet.clear();
		this.applyDefault();

		const answer = this.answers.get(q.id);
		if (!answer) return;

		if (answer.wasCustom) {
			if (q.allowOther) this.optionIndex = q.options.length;
			return;
		}

		const indices = (answer.indices ?? [])
			.map((i) => i - 1)
			.filter((i) => i >= 0 && i < q.options.length);
		if (indices.length === 0) return;

		this.optionIndex = indices[0];
		if (q.multiSelect) {
			this.selectedSet = new Set(indices);
		}
	}

	private switchToQuestion(index: number): void {
		if (index < 0 || index >= this.questions.length) return;

		this.showReview = false;
		this.inputActive = false;
		this.supplementing = false;
		this.editor.setText("");
		this.currentTab = index;
		this.restoreSelectionState();
		this.requestRender();
	}

	private switchToNextOrReview(): void {
		if (!this.currentQuestionAnswered()) return;

		if (this.currentTab < this.questions.length - 1) {
			this.switchToQuestion(this.currentTab + 1);
			return;
		}

		if (this.allAnswered()) {
			this.showReview = true;
			this.requestRender();
		}
	}

	// ── Answer management ──────────────────────────────────────────────

	private saveOptionAnswer(q: Question, selectedIndices: number[]): void {
		const opts = selectedIndices.map((i) => q.options[i]);
		this.answers.set(q.id, {
			id: q.id,
			value: opts.map((o) => o.value).join(", "),
			label: opts.map((o) => o.label).join(", "),
			wasCustom: false,
			indices: selectedIndices.map((i) => i + 1),
		});
	}

	private saveCustomAnswer(q: Question, text: string): void {
		const trimmed = text.trim() || "(no response)";
		this.answers.set(q.id, {
			id: q.id,
			value: trimmed,
			label: trimmed,
			wasCustom: true,
		});
	}

	private advanceAfterAnswer(): void {
		this.inputActive = false;
		this.supplementing = false;
		this.editor.setText("");
		this.selectedSet.clear();

		if (!this.isMulti) {
			// Single question: submit immediately
			this.submit(false);
			return;
		}

		this.switchToNextOrReview();
	}

	private submit(cancelled: boolean): void {
		this.onDone({
			questions: this.questions,
			answers: Array.from(this.answers.values()),
			cancelled,
		});
	}

	// ── Input handling ─────────────────────────────────────────────────

	handleInput(data: string): void {
		// Review mode
		if (this.showReview) {
			this.handleReviewInput(data);
			return;
		}

		// Inline input active ("Other" custom answer)
		if (this.inputActive) {
			this.handleEditorInput(data);
			return;
		}

		// Supplement mode (Tab on a regular option)
		if (this.supplementing) {
			this.handleSupplementInput(data);
			return;
		}

		const q = this.currentQuestion();
		if (!q) return;

		// Escape → cancel
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.submit(true);
			return;
		}

		// ←/→ question navigation. Moving forward requires the current question to be answered.
		if (this.isMulti && matchesKey(data, Key.left)) {
			this.switchToQuestion(this.currentTab - 1);
			return;
		}
		if (this.isMulti && matchesKey(data, Key.right)) {
			this.switchToNextOrReview();
			return;
		}

		// Tab → supplement current option (on a real option, not "Other")
		if (matchesKey(data, Key.tab) && !this.onOtherItem) {
			this.supplementing = true;
			this.editor.setText(this.answers.get(q.id)?.supplement ?? "");
			this.requestRender();
			return;
		}

		// ↑↓ option navigation (includes the "Other" virtual item)
		if (matchesKey(data, Key.up)) {
			this.optionIndex = Math.max(0, this.optionIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.optionIndex = Math.min(this.totalItems - 1, this.optionIndex + 1);
			this.requestRender();
			return;
		}

		// Number keys 1-9: quick select
		if (data >= "1" && data <= "9") {
			const idx = parseInt(data, 10) - 1;
			if (idx < q.options.length) {
				if (q.multiSelect) {
					// Toggle in multi-select
					if (this.selectedSet.has(idx)) {
						this.selectedSet.delete(idx);
					} else {
						this.selectedSet.add(idx);
					}
					this.optionIndex = idx;
					this.requestRender();
				} else {
					// Instant select in single-select
					this.saveOptionAnswer(q, [idx]);
					this.advanceAfterAnswer();
				}
			}
			return;
		}

		// Space: toggle in multi-select. "Other" is not a selectable option index.
		if (matchesKey(data, Key.space) && q.multiSelect) {
			if (this.onOtherItem) {
				this.inputActive = true;
				const answer = this.answers.get(q.id);
				this.editor.setText(answer?.wasCustom ? answer.label : "");
			} else if (this.selectedSet.has(this.optionIndex)) {
				this.selectedSet.delete(this.optionIndex);
			} else {
				this.selectedSet.add(this.optionIndex);
			}
			this.requestRender();
			return;
		}

		// Enter: confirm selection or activate "Other" input
		if (matchesKey(data, Key.enter)) {
			if (this.onOtherItem) {
				// Activate inline editor for custom answer
				this.inputActive = true;
				const answer = this.answers.get(q.id);
				this.editor.setText(answer?.wasCustom ? answer.label : "");
				this.requestRender();
				return;
			}
			if (q.multiSelect) {
				if (this.selectedSet.size > 0) {
					this.saveOptionAnswer(q, [...this.selectedSet].sort());
					this.advanceAfterAnswer();
				}
			} else {
				this.saveOptionAnswer(q, [this.optionIndex]);
				this.advanceAfterAnswer();
			}
			return;
		}
	}

	private handleSupplementInput(data: string): void {
		const q = this.currentQuestion();
		if (!q) return;

		if (matchesKey(data, Key.escape)) {
			this.supplementing = false;
			this.editor.setText("");
			this.requestRender();
			return;
		}

		// Enter (not Shift+Enter) → submit option + supplement
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			const supplement = this.editor.getText().trim() || undefined;

			if (q.multiSelect) {
				// Multi-select: save all toggled options; auto-toggle highlighted if none selected
				if (this.selectedSet.size === 0) {
					this.selectedSet.add(this.optionIndex);
				}
				const indices = [...this.selectedSet].sort();
				const opts = indices.map((i) => q.options[i]);
				this.answers.set(q.id, {
					id: q.id,
					value: opts.map((o) => o.value).join(", "),
					label: opts.map((o) => o.label).join(", "),
					wasCustom: false,
					indices: indices.map((i) => i + 1),
					supplement,
				});
			} else {
				// Single-select: save highlighted option
				const opt = q.options[this.optionIndex];
				this.answers.set(q.id, {
					id: q.id,
					value: opt.value,
					label: opt.label,
					wasCustom: false,
					indices: [this.optionIndex + 1],
					supplement,
				});
			}

			this.supplementing = false;
			this.editor.setText("");
			this.advanceAfterAnswer();
			return;
		}

		this.editor.handleInput(data);
		this.requestRender();
	}

	private handleEditorInput(data: string): void {
		const q = this.currentQuestion();
		if (!q) return;

		if (matchesKey(data, Key.escape)) {
			this.inputActive = false;
			this.editor.setText("");
			this.requestRender();
			return;
		}

		// Enter (not Shift+Enter) → submit custom answer
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCustomAnswer(q, this.editor.getText());
			this.advanceAfterAnswer();
			return;
		}

		this.editor.handleInput(data);
		// Always re-render: arrow keys move cursor without triggering onChange
		this.requestRender();
	}

	private handleReviewInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			if (this.allAnswered()) {
				this.submit(false);
			}
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.submit(true);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.switchToQuestion(this.questions.length - 1);
			return;
		}
	}

	// ── Rendering ──────────────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const t = this.theme;
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		add(t.fg("accent", "─".repeat(width)));

		if (this.showReview) {
			this.renderReview(lines, width);
		} else {
			// Tab bar for multi-question
			if (this.isMulti) {
				this.renderTabBar(lines, width);
			}
			this.renderQuestion(lines, width);
		}

		lines.push("");
		add(t.fg("accent", "─".repeat(width)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderTabBar(lines: string[], _width: number): void {
		const t = this.theme;
		const tabs: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const isActive = i === this.currentTab;
			const isAnswered = this.answers.has(this.questions[i].id);
			const lbl = this.questions[i].label;
			const icon = isAnswered ? "■" : "□";
			const color = isAnswered ? "success" : "muted";
			const text = ` ${icon} ${lbl} `;
			tabs.push(isActive ? t.bg("selectedBg", t.fg("text", text)) : t.fg(color, text));
		}
		lines.push(` ${tabs.join(" ")}`);
		lines.push("");
	}

	private renderQuestion(lines: string[], width: number): void {
		const t = this.theme;
		const q = this.currentQuestion();
		if (!q) return;

		// Prompt
		for (const line of wrapTextWithAnsi(t.fg("text", q.prompt), width - 1)) {
			lines.push(` ${line}`);
		}
		lines.push("");

		// Options
		for (let i = 0; i < q.options.length; i++) {
			const opt = q.options[i];
			const isCurrent = i === this.optionIndex && !this.inputActive;
			const isSelected = q.multiSelect && this.selectedSet.has(i);

			const pointer = isCurrent ? t.fg("accent", "> ") : "  ";
			const num = `${i + 1}. `;
			const checkbox = q.multiSelect ? (isSelected ? t.fg("success", "☑ ") : t.fg("muted", "☐ ")) : "";
			const label = isCurrent ? t.fg("accent", opt.label) : opt.label;

			lines.push(truncateToWidth(`${pointer}${num}${checkbox}${label}`, width));
			if (opt.description) {
				const indent = q.multiSelect ? "       " : "     ";
				lines.push(truncateToWidth(`${indent}${t.fg("muted", opt.description)}`, width));
			}

			// Supplement editor (shown inline below the highlighted option)
			if (this.supplementing && i === this.optionIndex) {
				lines.push("");
				for (const line of this.editor.render(width - 6)) {
					lines.push(truncateToWidth(`      ${line}`, width));
				}
				lines.push(truncateToWidth(`      ${t.fg("dim", "Enter submit · Shift+Enter newline · Esc back")}`, width));
			}
		}

		// "Other" option + inline editor (when allowOther)
		if (q.allowOther) {
			const isOtherCurrent = this.onOtherItem && !this.inputActive;
			const pointer = isOtherCurrent ? t.fg("accent", "> ") : "  ";
			const otherLabel = isOtherCurrent
				? t.fg("accent", "Other (type your answer)")
				: t.fg("dim", "Other (type your answer)");
			lines.push(truncateToWidth(`${pointer}${otherLabel}`, width));

			if (this.inputActive) {
				lines.push("");
				for (const line of this.editor.render(width - 2)) {
					lines.push(truncateToWidth(` ${line}`, width));
				}
				lines.push(truncateToWidth(` ${t.fg("dim", "Enter submit · Shift+Enter newline · Esc back")}`, width));
			}
		}

		// Help line
		lines.push("");
		if (this.inputActive) return; // help already shown above
		const parts: string[] = [];
		if (this.isMulti) {
			parts.push(`${t.fg("dim", "←/→")} questions`);
		}
		parts.push(`${t.fg("dim", "↑↓")} nav`);
		parts.push(`${t.fg("dim", "1-9")} quick`);
		if (q.multiSelect) {
			parts.push(`${t.fg("dim", "Space")} toggle`);
		}
		parts.push(`${t.fg("dim", "Enter")} confirm`);
		parts.push(`${t.fg("dim", "Tab")} annotate`);
		parts.push(`${t.fg("dim", "Esc")} cancel`);
		lines.push(truncateToWidth(` ${parts.join(" · ")}`, width));
	}

	private renderReview(lines: string[], width: number): void {
		const t = this.theme;

		lines.push(truncateToWidth(` ${t.fg("accent", t.bold("Review Answers"))}`, width));
		lines.push("");

		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers.get(q.id);
			const num = t.fg("dim", `${i + 1}. `);
			const label = t.fg("muted", `${q.label}: `);
			if (a) {
				const prefix = a.wasCustom ? t.fg("dim", "(wrote) ") : "";
				lines.push(truncateToWidth(` ${num}${label}${prefix}${t.fg("text", a.label)}`, width));
			} else {
				lines.push(truncateToWidth(` ${num}${label}${t.fg("warning", "(unanswered)")}`, width));
			}
		}

		lines.push("");
		if (this.allAnswered()) {
			lines.push(truncateToWidth(` ${t.fg("success", "Enter to submit")} · ${t.fg("dim", "← edit · Esc cancel")}`, width));
		} else {
			const missing = this.questions
				.filter((q) => !this.answers.has(q.id))
				.map((q) => q.label)
				.join(", ");
			lines.push(truncateToWidth(` ${t.fg("warning", `Unanswered: ${missing}`)} · ${t.fg("dim", "← edit · Esc cancel")}`, width));
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
