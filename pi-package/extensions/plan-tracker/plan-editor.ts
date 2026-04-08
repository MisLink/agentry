/**
 * Interactive TUI component for reviewing and editing extracted plan steps.
 *
 * Inspired by mitsuhiko's answer.ts QnAComponent.
 * Users can toggle steps on/off, edit text, reorder, then confirm.
 */

import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { PlanStep } from "./utils.js";

export interface PlanEditorResult {
	steps: PlanStep[];
	cancelled: boolean;
}

export class PlanEditorComponent implements Component {
	private steps: Array<{ step: number; text: string; detail: string; enabled: boolean }>;
	private cursor = 0;
	private editingIndex: number | null = null;
	private editBuffer = "";
	private editCursorPos = 0;
	private onDone: (result: PlanEditorResult) => void;

	// Render cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// ANSI helpers
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
	private inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

	constructor(steps: PlanStep[], onDone: (result: PlanEditorResult) => void) {
		this.steps = steps.map((s) => ({
			step: s.step,
			text: s.text,
			detail: s.detail,
			enabled: true,
		}));
		this.onDone = onDone;
	}

	private submit(): void {
		const enabledSteps = this.steps
			.filter((s) => s.enabled)
			.map((s, i) => ({
				step: i + 1,
				text: s.text,
				detail: s.detail,
				completed: false,
			}));
		this.onDone({ steps: enabledSteps, cancelled: false });
	}

	private cancel(): void {
		this.onDone({ steps: [], cancelled: true });
	}

	handleInput(data: string): void {
		// ── Editing mode ──
		if (this.editingIndex !== null) {
			if (matchesKey(data, Key.enter)) {
				// Commit edit
				this.steps[this.editingIndex].text = this.editBuffer.trim() || this.steps[this.editingIndex].text;
				this.editingIndex = null;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				// Discard edit
				this.editingIndex = null;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				if (this.editCursorPos > 0) {
					this.editBuffer =
						this.editBuffer.slice(0, this.editCursorPos - 1) + this.editBuffer.slice(this.editCursorPos);
					this.editCursorPos--;
				}
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.delete)) {
				if (this.editCursorPos < this.editBuffer.length) {
					this.editBuffer =
						this.editBuffer.slice(0, this.editCursorPos) + this.editBuffer.slice(this.editCursorPos + 1);
				}
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.left)) {
				if (this.editCursorPos > 0) this.editCursorPos--;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.right)) {
				if (this.editCursorPos < this.editBuffer.length) this.editCursorPos++;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.home)) {
				this.editCursorPos = 0;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.end)) {
				this.editCursorPos = this.editBuffer.length;
				this.invalidate();
				return;
			}
			// Printable character
			if (data.length === 1 && data >= " ") {
				this.editBuffer = this.editBuffer.slice(0, this.editCursorPos) + data + this.editBuffer.slice(this.editCursorPos);
				this.editCursorPos++;
				this.invalidate();
				return;
			}
			return;
		}

		// ── Normal navigation ──
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.submit();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.cursor > 0) {
				this.cursor--;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.cursor < this.steps.length - 1) {
				this.cursor++;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.steps[this.cursor].enabled = !this.steps[this.cursor].enabled;
			this.invalidate();
			return;
		}
		if (data === "e") {
			this.editingIndex = this.cursor;
			this.editBuffer = this.steps[this.cursor].text;
			this.editCursorPos = this.editBuffer.length;
			this.invalidate();
			return;
		}
		// Move up
		if (matchesKey(data, Key.shift("up")) || data === "K") {
			if (this.cursor > 0) {
				const tmp = this.steps[this.cursor];
				this.steps[this.cursor] = this.steps[this.cursor - 1];
				this.steps[this.cursor - 1] = tmp;
				this.cursor--;
				this.invalidate();
			}
			return;
		}
		// Move down
		if (matchesKey(data, Key.shift("down")) || data === "J") {
			if (this.cursor < this.steps.length - 1) {
				const tmp = this.steps[this.cursor];
				this.steps[this.cursor] = this.steps[this.cursor + 1];
				this.steps[this.cursor + 1] = tmp;
				this.cursor++;
				this.invalidate();
			}
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 2, 100);
		const contentWidth = boxWidth - 6;
		const h = (n: number) => "─".repeat(n);

		const pad = (content: string): string => {
			const padded = "  " + content;
			const cLen = visibleWidth(padded);
			const right = Math.max(0, boxWidth - cLen - 2);
			return this.dim("│") + padded + " ".repeat(right) + this.dim("│");
		};
		const empty = (): string => this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		const fit = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		const enabledCount = this.steps.filter((s) => s.enabled).length;
		lines.push(fit(this.dim("╭" + h(boxWidth - 2) + "╮")));
		lines.push(
			fit(
				pad(
					`${this.bold(this.cyan("📋 Plan"))} ${this.dim(`(${enabledCount}/${this.steps.length} steps)`)}`,
				),
			),
		);
		lines.push(fit(this.dim("├" + h(boxWidth - 2) + "┤")));

		// Steps
		for (let i = 0; i < this.steps.length; i++) {
			const s = this.steps[i];
			const isCurrent = i === this.cursor;
			const isEditing = this.editingIndex === i;

			const pointer = isCurrent ? this.cyan("▸ ") : "  ";
			const checkbox = s.enabled ? this.green("☑ ") : this.dim("☐ ");

			if (isEditing) {
				// Show edit buffer with cursor
				const before = this.editBuffer.slice(0, this.editCursorPos);
				const cursorChar = this.editCursorPos < this.editBuffer.length ? this.editBuffer[this.editCursorPos] : " ";
				const after = this.editBuffer.slice(this.editCursorPos + 1);
				const editLine = `${pointer}${checkbox}${before}${this.inverse(cursorChar)}${after}`;
				lines.push(fit(pad(truncateToWidth(editLine, contentWidth))));
			} else {
				const text = isCurrent ? this.bold(s.text) : s.enabled ? s.text : this.dim(s.text);
				lines.push(fit(pad(truncateToWidth(`${pointer}${checkbox}${text}`, contentWidth))));
			}
		}

		lines.push(fit(empty()));

		// Detail of current step
		if (this.steps[this.cursor]) {
			const detail = this.steps[this.cursor].detail;
			if (detail && detail !== this.steps[this.cursor].text) {
				const wrapped = wrapTextWithAnsi(this.gray(`  ${detail}`), contentWidth);
				for (const line of wrapped) {
					lines.push(fit(pad(line)));
				}
				lines.push(fit(empty()));
			}
		}

		// Footer
		lines.push(fit(this.dim("├" + h(boxWidth - 2) + "┤")));
		const editHint = this.editingIndex !== null ? `${this.yellow("editing")} Enter confirm · Esc cancel` : "";
		const navHint =
			this.editingIndex === null
				? `${this.dim("↑↓")} nav · ${this.dim("Space")} toggle · ${this.dim("e")} edit · ${this.dim("Shift+↑↓")} reorder · ${this.dim("Enter")} confirm · ${this.dim("Esc")} cancel`
				: editHint;
		lines.push(fit(pad(truncateToWidth(navHint, contentWidth))));
		lines.push(fit(this.dim("╰" + h(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
