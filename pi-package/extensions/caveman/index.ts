/**
 * caveman/index.ts — session-scoped caveman mode for pi.
 *
 * Reuses an installed `caveman` skill as the source of truth for prompt content,
 * while this extension provides:
 *   - /caveman [level|off] command
 *   - session-only persistence via custom entries
 *   - status footer badge
 *   - before_agent_start injection of the skill body + runtime level override
 *
 * No global config file. New sessions start with caveman full.
 */

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SKILL_NAME = "caveman";
const SESSION_ENTRY = "caveman-level";

const LEVELS = [
  "off",
  "lite",
  "full",
  "ultra",
  "wenyan-lite",
  "wenyan-full",
  "wenyan-ultra",
] as const;
const STOP_ALIASES = new Set(["off", "stop", "quit"]);
const LEVEL_LABELS: Record<Exclude<Level, "off">, string> = {
  lite: "LITE",
  full: "FULL",
  ultra: "ULTRA",
  "wenyan-lite": "文言-LITE",
  "wenyan-full": "文言",
  "wenyan-ultra": "文言-ULTRA",
};
const LEVEL_ALIASES: Record<string, Level> = {
  wenyan: "wenyan-full",
};

type Level = (typeof LEVELS)[number];

const COMMAND_OPTIONS = [
  { value: "lite", label: "lite", description: "Professional, no fluff" },
  { value: "full", label: "full", description: "Classic caveman" },
  { value: "ultra", label: "ultra", description: "Maximum compression" },
  { value: "wenyan-lite", label: "wenyan-lite", description: "Semi-classical Chinese" },
  { value: "wenyan-full", label: "wenyan-full", description: "Full 文言文" },
  { value: "wenyan-ultra", label: "wenyan-ultra", description: "Extreme 文言文" },
  { value: "off", label: "off", description: "Disable caveman mode" },
  { value: "stop", label: "stop", description: "Disable caveman mode" },
  { value: "quit", label: "quit", description: "Disable caveman mode" },
] as const;

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function normalizeLevel(input: string | undefined, current: Level): Level | null {
  const raw = input?.trim().toLowerCase();
  if (!raw) return current === "off" ? "full" : "off";
  if (STOP_ALIASES.has(raw)) return "off";
  const normalized = LEVEL_ALIASES[raw] ?? raw;
  return LEVELS.includes(normalized as Level) ? (normalized as Level) : null;
}

export function buildLanguageOverride(): string {
  return [
    "- Reply in same language as user's input for this turn.",
    "- Keep active caveman level; do not switch response language unless user does.",
  ].join("\n");
}

function normalizeSkillPath(path: string): string {
  return path.endsWith("SKILL.md") ? path : join(path, "SKILL.md");
}

function skillCommandPath(pi: ExtensionAPI): string | null {
  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    if (command.name !== `skill:${SKILL_NAME}`) continue;
    if (command.sourceInfo?.path) return normalizeSkillPath(command.sourceInfo.path);
  }
  return null;
}

function candidateSkillPaths(cwd: string): string[] {
  const paths = new Set<string>();

  paths.add(join(homedir(), ".agents", "skills", SKILL_NAME, "SKILL.md"));
  paths.add(join(homedir(), ".pi", "agent", "skills", SKILL_NAME, "SKILL.md"));

  let dir = resolve(cwd);
  for (;;) {
    paths.add(join(dir, ".agents", "skills", SKILL_NAME, "SKILL.md"));
    paths.add(join(dir, ".pi", "skills", SKILL_NAME, "SKILL.md"));
    paths.add(join(dir, "skills", SKILL_NAME, "SKILL.md"));

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return [...paths];
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function installHint(): string {
  return [
    "Caveman skill not found.",
    "",
    "Install it into one of these locations:",
    "- ~/.agents/skills/caveman/SKILL.md",
    "- ~/.pi/agent/skills/caveman/SKILL.md",
    "- .agents/skills/caveman/SKILL.md",
    "",
    "Then run /reload and try /caveman again.",
  ].join("\n");
}

export default function caveman(pi: ExtensionAPI) {
  let level: Level = "full";
  let skillPath: string | null = null;
  let skillBody: string | null = null;
  let missingSkillWarned = false;

  function syncStatus(ctx: ExtensionContext): void {
    if (level === "off") {
      ctx.ui.setStatus("caveman", undefined);
      return;
    }

    if (!skillPath) {
      ctx.ui.setStatus("caveman", ctx.ui.theme.fg("warning", "🪨 skill missing"));
      return;
    }

    ctx.ui.setStatus("caveman", `🪨 ${LEVEL_LABELS[level]}`);
  }

  async function warnMissingSkill(ctx: ExtensionContext): Promise<void> {
    if (missingSkillWarned) return;
    missingSkillWarned = true;
    ctx.ui.notify(installHint(), "warning");
  }

  async function resolveSkill(cwd: string): Promise<string | null> {
    if (skillPath) return skillPath;

    const commandPath = skillCommandPath(pi);
    if (commandPath) {
      const existingCommandPath = await firstExisting([commandPath]);
      if (existingCommandPath) {
        skillPath = existingCommandPath;
        return skillPath;
      }
    }

    skillPath = await firstExisting(candidateSkillPaths(cwd));
    return skillPath;
  }

  async function ensureSkillBody(cwd: string): Promise<string | null> {
    if (skillBody) return skillBody;

    const path = await resolveSkill(cwd);
    if (!path) return null;

    try {
      const raw = await readFile(path, "utf8");
      skillBody = stripFrontmatter(raw);
      return skillBody;
    } catch {
      skillPath = null;
      skillBody = null;
      return null;
    }
  }

  function persistLevel(): void {
    pi.appendEntry(SESSION_ENTRY, { level });
  }

  pi.on("session_start", async (_event, ctx) => {
    missingSkillWarned = false;
    skillPath = null;
    skillBody = null;
    level = "full";

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY) continue;
      const entryLevel = (entry.data as { level?: Level } | undefined)?.level;
      if (entryLevel && LEVELS.includes(entryLevel)) {
        level = entryLevel;
      }
    }

    await resolveSkill(ctx.cwd);
    if (!skillPath) {
      await warnMissingSkill(ctx);
    }
    syncStatus(ctx);
  });

  pi.registerCommand("caveman", {
    description: "Toggle caveman mode or set level: lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra, off",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const matches = COMMAND_OPTIONS.filter((item) => item.value.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const next = normalizeLevel(args, level);
      if (!next) {
        ctx.ui.notify(
          `Unknown caveman level: ${args?.trim()}. Use: ${LEVELS.join(", ")}, stop, or quit.`,
          "error",
        );
        return;
      }

      if (next !== "off") {
        await resolveSkill(ctx.cwd);
        if (!skillPath) {
          await warnMissingSkill(ctx);
          syncStatus(ctx);
          return;
        }
      }

      level = next;
      persistLevel();
      syncStatus(ctx);

      ctx.ui.notify(
        level === "off" ? "Caveman mode off." : `Caveman mode: ${LEVEL_LABELS[level]}`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (level === "off") return;

    const body = await ensureSkillBody(ctx.cwd);
    if (!body) {
      await warnMissingSkill(ctx);
      syncStatus(ctx);
      return;
    }

    syncStatus(ctx);
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `[Loaded skill: ${SKILL_NAME}]\n${body}\n\n` +
        `Runtime override:\n` +
        `- Caveman mode is active for this session.\n` +
        `- Active level: ${level}.\n` +
        `- Persist until user runs /caveman off.\n` +
        `- Follow the active level even if the skill text mentions another default.\n` +
        `${buildLanguageOverride()}`,
    };
  });
}
