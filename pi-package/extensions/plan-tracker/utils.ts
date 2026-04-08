/**
 * Shared types and utilities for plan-tracker extension.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlanStep {
	step: number;
	text: string; // Short display text (≤60 chars, for widget)
	detail: string; // Full description (for AI context injection)
	completed: boolean;
	summary?: string; // Work log entry from mark_done
	completedAt?: number; // Timestamp for elapsed-time display
}

export interface PlanState {
	steps: PlanStep[];
	startedAt: number;
	pauseOnStep: boolean;
}

// ── Message helpers ────────────────────────────────────────────────────────

export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

export function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ── Regex pre-filter ───────────────────────────────────────────────────────

/**
 * Cheap check: does the text contain 3+ numbered list items?
 * Used as a gate before calling the extraction LLM.
 */
export function looksLikePlan(text: string): boolean {
	const matches = text.match(/^\s*\d+[.)]\s+\S/gm);
	return (matches?.length ?? 0) >= 3;
}

// ── Display helpers ────────────────────────────────────────────────────────

export function truncateText(text: string, maxLen: number): string {
	const cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLen) return cleaned;
	return `${cleaned.slice(0, maxLen - 3)}...`;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}
