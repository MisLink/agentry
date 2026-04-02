/**
 * Checker registry.
 *
 * ALL_CHECKERS is the single source of truth for which languages are
 * supported. To add a new language: implement LanguageChecker, import it
 * here, and append it to the array — nothing else needs to change.
 */

import type { LanguageChecker } from "../types.js";
import { goChecker } from "./go.js";
import { pythonChecker } from "./python.js";
import { rustChecker } from "./rust.js";
import { typescriptChecker } from "./typescript.js";

export const ALL_CHECKERS: LanguageChecker[] = [
  typescriptChecker,
  pythonChecker,
  goChecker,
  rustChecker,
];

/**
 * Return the checker responsible for a given file path, based on extension.
 * Returns null if no registered checker handles that extension.
 */
export function getCheckerForFile(
  filePath: string,
  checkers: LanguageChecker[] = ALL_CHECKERS,
): LanguageChecker | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return null;
  const ext = filePath.slice(lastDot).toLowerCase();
  return checkers.find((c) => c.extensions.includes(ext)) ?? null;
}
