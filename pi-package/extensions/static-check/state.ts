/**
 * CheckerState — all mutable runtime state for the extension.
 *
 * Covers steps 4, 5 and 6 of the implementation plan:
 *
 *   Step 4 — track which files the LLM edited during the current agent turn
 *   Step 5 — per-project baseline (prevFingerprints) and delta computation
 *   Step 6 — loop detection via a ring buffer of recent new-error sets
 */

import type { CheckerConfig, Diagnostic, ProjectCheckState } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export class CheckerState {
  // ── Global config (mutated by /staticcheck commands) ────────────────────
  config: CheckerConfig = { ...DEFAULT_CONFIG, disabled: new Set() };

  // ── Per-turn file tracking (Step 4) ────────────────────────────────────

  /**
   * Absolute paths of files the LLM wrote or edited during the current
   * agent session (before_agent_start → agent_end).
   * Cleared in agent_end after checks run.
   */
  readonly modifiedFiles = new Set<string>();

  // ── Per-project check state (Steps 5 & 6) ─────────────────────────────

  /** Key: "${checkerId}:${projectRoot}" */
  private readonly projectStates = new Map<string, ProjectCheckState>();

  /** Checker ids for which we've already shown a "tool not found" notice. */
  readonly notifiedMissing = new Set<string>();

  // ── Project state accessors ────────────────────────────────────────────

  getProjectState(checkerId: string, projectRoot: string): ProjectCheckState {
    const key = `${checkerId}:${projectRoot}`;
    if (!this.projectStates.has(key)) {
      this.projectStates.set(key, {
        projectRoot,
        checkerId,
        prevFingerprints: null, // null = never checked
        recentNewSetKeys: [],
      });
    }
    return this.projectStates.get(key)!;
  }

  // ── Step 5: Delta computation ──────────────────────────────────────────

  /**
   * Compute which diagnostics are NEW compared to the previous check.
   *
   * First run (prevFingerprints === null):
   *   All diagnostics are returned — the LLM needs to see the full
   *   initial state of the project.
   *
   * Subsequent runs:
   *   Only diagnostics whose fingerprint was NOT in prevFingerprints
   *   are returned. This filters out pre-existing errors so the LLM
   *   stays focused on what it actually broke.
   */
  getDelta(
    checkerId: string,
    projectRoot: string,
    current: Diagnostic[],
  ): Diagnostic[] {
    const st = this.getProjectState(checkerId, projectRoot);
    if (st.prevFingerprints === null) return current;
    return current.filter((d) => !st.prevFingerprints!.has(d.fingerprint));
  }

  /**
   * Save the current diagnostics as the baseline for the next turn.
   * Must be called after getDelta() so the baseline advances correctly.
   */
  updateBaseline(
    checkerId: string,
    projectRoot: string,
    current: Diagnostic[],
  ): void {
    const st = this.getProjectState(checkerId, projectRoot);
    st.prevFingerprints = new Set(current.map((d) => d.fingerprint));
  }

  // ── Step 6: Loop detection ─────────────────────────────────────────────

  /**
   * Record the new-error set for this turn and return true if the LLM
   * appears to be stuck in a loop (same set of new errors for
   * config.loopThreshold consecutive turns).
   *
   * Must be called AFTER getDelta() with the delta result.
   */
  recordAndCheckLoop(
    checkerId: string,
    projectRoot: string,
    newErrors: Diagnostic[],
  ): boolean {
    const st = this.getProjectState(checkerId, projectRoot);
    const threshold = this.config.loopThreshold;

    // Stable key for this error set: sorted fingerprints joined.
    const setKey = newErrors
      .map((d) => d.fingerprint)
      .sort()
      .join("|");

    // Maintain ring buffer of size loopThreshold.
    st.recentNewSetKeys.push(setKey);
    if (st.recentNewSetKeys.length > threshold) {
      st.recentNewSetKeys.shift();
    }

    // Loop detected when buffer is full and every entry is identical.
    return (
      st.recentNewSetKeys.length >= threshold &&
      st.recentNewSetKeys.every((k) => k === setKey)
    );
  }

  // ── Lifecycle resets ───────────────────────────────────────────────────

  /** Clear per-turn modified-file tracking. Called in agent_end. */
  resetTurn(): void {
    this.modifiedFiles.clear();
  }

  /**
   * Clear all per-project baselines and loop-detection history.
   * Called on session_start / session_switch / session_fork / session_tree
   * so stale state from a previous session doesn't pollute the new one.
   */
  resetSession(): void {
    this.projectStates.clear();
    this.notifiedMissing.clear();
  }
}
