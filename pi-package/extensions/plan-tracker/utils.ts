/**
 * Shared types and utilities for plan-tracker extension.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlanStep {
	step: number;
	text: string; // Short display text (≤60 chars, for widget)
	detail: string; // Full description (for AI context injection)
	completed: boolean;
	summary?: string; // Work log entry from mark_done
	completedAt?: number; // Timestamp for elapsed-time display
}

// ── Display helpers ────────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}
