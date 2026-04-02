/**
 * Generic project-root discovery.
 *
 * Walks up the directory tree from a starting path until it finds a
 * directory that contains one of the given config-file markers.
 *
 * Results are cached per (startDir, configFiles) pair within the process
 * lifetime to avoid repeated filesystem traversal across multiple checks
 * in the same session.
 */

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Cache key → resolved project root (or null if not found). */
const cache = new Map<string, string | null>();

/**
 * Walk up from startDir, returning the first ancestor directory that
 * contains any of the configFiles. Returns null if none is found.
 *
 * @param startDir   Absolute path to start searching from (usually dirname
 *                   of the file that was just edited).
 * @param configFiles Filenames to look for, e.g. ["tsconfig.json"].
 */
export async function findProjectRoot(
  startDir: string,
  configFiles: string[],
): Promise<string | null> {
  const cacheKey = `${startDir}\0${configFiles.join(",")}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let dir = startDir;
  while (true) {
    for (const cf of configFiles) {
      try {
        await access(join(dir, cf));
        cache.set(cacheKey, dir);
        return dir;
      } catch {
        // Not in this directory — keep climbing.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root.
    dir = parent;
  }

  cache.set(cacheKey, null);
  return null;
}

/**
 * Clear the project-root cache.
 * Call when the working directory changes or on session switch.
 */
export function clearProjectRootCache(): void {
  cache.clear();
}
