/**
 * Files Extension — Interactive file browser with fuzzy search.
 *
 * Commands:
 *   /files           — browse all repo files with fuzzy search
 *   /diff            — browse only dirty (modified) files
 *
 * After selecting a file, offers quick actions:
 *   - Open (default app)
 *   - Reveal in Finder
 *   - Diff in VS Code
 *   - Add to prompt
 *
 * Supports both git and jj (Jujutsu) repos.
 */

import { existsSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	Key,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import { notifyBeforePrompt } from "../notify/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface FileEntry {
	/** Canonical absolute path */
	path: string;
	/** Relative display path */
	display: string;
	/** VCS status label (M, A, D, ??, R, etc.) */
	status?: string;
	exists: boolean;
	isDirectory: boolean;
	/** File was referenced in the session (mentioned in messages/tool calls) */
	isReferenced: boolean;
	/** File was modified by the AI in this session */
	hasSessionChange: boolean;
}

type VCS = "jj" | "git";

// ── VCS Detection ──────────────────────────────────────────────────────────

async function detectVCS(pi: ExtensionAPI, cwd: string): Promise<VCS> {
	const jjResult = await pi.exec("test", ["-d", ".jj"], { cwd });
	return jjResult.code === 0 ? "jj" : "git";
}

// ── File Listing ───────────────────────────────────────────────────────────

async function getRepoRoot(pi: ExtensionAPI, cwd: string, vcs: VCS): Promise<string | null> {
	if (vcs === "jj") {
		const r = await pi.exec("jj", ["workspace", "root"], { cwd, timeout: 5000 });
		return r.code === 0 ? r.stdout.trim() : null;
	}
	const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
	return r.code === 0 ? r.stdout.trim() : null;
}

interface StatusEntry { status: string; exists: boolean }

async function getStatusMap(
	pi: ExtensionAPI, cwd: string, vcs: VCS,
): Promise<Map<string, StatusEntry>> {
	const map = new Map<string, StatusEntry>();

	if (vcs === "jj") {
		// jj status outputs lines like:
		//   M path/to/file
		//   A path/to/file
		//   D path/to/file
		const r = await pi.exec("jj", ["status", "--no-pager"], { cwd, timeout: 10000 });
		if (r.code !== 0) return map;
		for (const line of r.stdout.split("\n")) {
			const match = line.match(/^([MADR?C])\s+(.+)$/);
			if (!match) continue;
			const [, status, filePath] = match;
			const abs = path.resolve(cwd, filePath.trim());
			map.set(abs, { status, exists: existsSync(abs) });
		}
	} else {
		const r = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd, timeout: 10000 });
		if (r.code !== 0 || !r.stdout) return map;
		const entries = r.stdout.split("\0").filter(Boolean);
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry || entry.length < 4) continue;
			const status = entry.slice(0, 2).trim() || "?";
			let filePath = entry.slice(3);
			if ((entry[0] === "R" || entry[0] === "C") && entries[i + 1]) {
				filePath = entries[i + 1];
				i++;
			}
			if (!filePath) continue;
			const abs = path.resolve(cwd, filePath);
			map.set(abs, { status, exists: existsSync(abs) });
		}
	}

	return map;
}

async function getAllFiles(
	pi: ExtensionAPI, cwd: string, root: string, vcs: VCS,
): Promise<Set<string>> {
	const files = new Set<string>();

	if (vcs === "jj") {
		// jj file list shows all tracked files
		const r = await pi.exec("jj", ["file", "list", "--no-pager"], { cwd: root, timeout: 10000 });
		if (r.code === 0) {
			for (const line of r.stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed) files.add(path.resolve(root, trimmed));
			}
		}
	} else {
		// git tracked + untracked
		const tracked = await pi.exec("git", ["ls-files", "-z"], { cwd: root, timeout: 10000 });
		if (tracked.code === 0 && tracked.stdout) {
			for (const f of tracked.stdout.split("\0").filter(Boolean)) {
				files.add(path.resolve(root, f));
			}
		}
		const untracked = await pi.exec(
			"git", ["ls-files", "-z", "--others", "--exclude-standard"],
			{ cwd: root, timeout: 10000 },
		);
		if (untracked.code === 0 && untracked.stdout) {
			for (const f of untracked.stdout.split("\0").filter(Boolean)) {
				files.add(path.resolve(root, f));
			}
		}
	}

	return files;
}

// ── Session Reference Extraction ───────────────────────────────────────────

const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

function extractPathsFromEntry(entry: SessionEntry, cwd: string): string[] {
	const paths: string[] = [];

	const extractFromText = (text: string) => {
		for (const match of text.matchAll(PATH_REGEX)) {
			let p = match[1].replace(/[.,;:)\]]+$/, "");
			// Strip line:col suffixes
			p = p.replace(/:(\d+)(:\d+)?$/, "");
			if (p.startsWith("~")) p = path.join(require("os").homedir(), p.slice(1));
			if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
			paths.push(p);
		}
	};

	const extractFromContent = (content: unknown) => {
		if (typeof content === "string") {
			extractFromText(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") {
					extractFromText(block.text);
				}
				if (block?.type === "toolCall" && block.arguments) {
					const args = block.arguments as Record<string, unknown>;
					for (const key of ["path", "file", "filePath"]) {
						if (typeof args[key] === "string") paths.push(path.resolve(cwd, args[key] as string));
					}
				}
			}
		}
	};

	if (entry.type === "message" && "content" in entry.message) {
		extractFromContent(entry.message.content);
	}
	return paths;
}

function collectSessionChanges(entries: SessionEntry[], cwd: string): Set<string> {
	const changed = new Set<string>();
	const toolCalls = new Map<string, string>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && (block.name === "write" || block.name === "edit")) {
					const p = (block.arguments as Record<string, unknown>)?.path;
					if (typeof p === "string") toolCalls.set(block.id, path.resolve(cwd, p));
				}
			}
		}
		if (msg.role === "toolResult" && toolCalls.has(msg.toolCallId)) {
			changed.add(toolCalls.get(msg.toolCallId)!);
		}
	}

	return changed;
}

function collectReferencedFiles(entries: SessionEntry[], cwd: string, limit: number): Set<string> {
	const refs = new Set<string>();
	for (let i = entries.length - 1; i >= 0 && refs.size < limit; i--) {
		for (const p of extractPathsFromEntry(entries[i], cwd)) {
			if (existsSync(p)) refs.add(p);
			if (refs.size >= limit) break;
		}
	}
	return refs;
}

// ── Build File Entries ─────────────────────────────────────────────────────

async function buildFileEntries(
	pi: ExtensionAPI, ctx: ExtensionContext, dirtyOnly: boolean,
): Promise<{ files: FileEntry[]; vcs: VCS }> {
	const vcs = await detectVCS(pi, ctx.cwd);
	const root = await getRepoRoot(pi, ctx.cwd, vcs);
	if (!root) return { files: [], vcs };

	const statusMap = await getStatusMap(pi, ctx.cwd, vcs);
	const entries = ctx.sessionManager.getBranch();
	const sessionChanges = collectSessionChanges(entries, ctx.cwd);
	const referenced = collectReferencedFiles(entries, ctx.cwd, 200);

	const fileMap = new Map<string, FileEntry>();
	const addFile = (abs: string, extra?: Partial<FileEntry>) => {
		if (fileMap.has(abs)) {
			const existing = fileMap.get(abs)!;
			if (extra?.isReferenced) existing.isReferenced = true;
			if (extra?.hasSessionChange) existing.hasSessionChange = true;
			if (extra?.status && !existing.status) existing.status = extra.status;
			return;
		}
		const display = abs.startsWith(root + path.sep)
			? path.relative(root, abs)
			: abs;
		const exists = existsSync(abs);
		let isDir = false;
		try { isDir = exists && statSync(abs).isDirectory(); } catch {}
		if (isDir) return; // skip directories

		fileMap.set(abs, {
			path: abs,
			display,
			status: statusMap.get(abs)?.status ?? extra?.status,
			exists,
			isDirectory: false,
			isReferenced: extra?.isReferenced ?? referenced.has(abs),
			hasSessionChange: extra?.hasSessionChange ?? sessionChanges.has(abs),
		});
	};

	if (dirtyOnly) {
		// Only dirty files
		for (const [abs, entry] of statusMap) {
			addFile(abs, { status: entry.status });
		}
	} else {
		// All repo files
		const allFiles = await getAllFiles(pi, ctx.cwd, root, vcs);
		for (const abs of allFiles) addFile(abs);
		// Add dirty files not in repo listing (new untracked)
		for (const [abs, entry] of statusMap) addFile(abs, { status: entry.status });
		// Add session-referenced files even if outside repo
		for (const abs of referenced) addFile(abs, { isReferenced: true });
		for (const abs of sessionChanges) addFile(abs, { hasSessionChange: true });
	}

	const files = [...fileMap.values()].sort((a, b) => {
		// Dirty first
		if (Boolean(a.status) !== Boolean(b.status)) return a.status ? -1 : 1;
		// Session changes next
		if (a.hasSessionChange !== b.hasSessionChange) return a.hasSessionChange ? -1 : 1;
		// Referenced next
		if (a.isReferenced !== b.isReferenced) return a.isReferenced ? -1 : 1;
		// Alpha
		return a.display.localeCompare(b.display);
	});

	return { files, vcs };
}

// ── VS Code CLI Detection ──────────────────────────────────────────────────

/**
 * Find the VS Code CLI binary. Supports:
 * - Local: `code` on PATH
 * - VS Code Remote SSH/WSL/Container: ~/.vscode-server/bin/.../remote-cli/code
 * - Cursor Remote: ~/.cursor-server/bin/.../remote-cli/code
 *
 * In Remote environments, the CLI communicates back to the local VS Code
 * instance via the VSCODE_IPC_HOOK_CLI socket.
 */
async function findCodeCli(pi: ExtensionAPI): Promise<string | null> {
	// 1. `code` on PATH (works locally + in VS Code integrated terminal)
	const which = await pi.exec("which", ["code"], { timeout: 3000 });
	if (which.code === 0 && which.stdout.trim()) return "code";

	// 2. VS Code Remote server locations
	const home = os.homedir();
	for (const serverDir of [".vscode-server", ".cursor-server"]) {
		const base = path.join(home, serverDir, "bin");
		try {
			const versions = readdirSync(base).sort().reverse();
			for (const ver of versions) {
				const cli = path.join(base, ver, "bin", "remote-cli", "code");
				if (existsSync(cli)) return cli;
			}
		} catch {
			// directory doesn't exist
		}
	}

	return null;
}

// ── Diff in VS Code ────────────────────────────────────────────────────────

/**
 * Open a VCS diff in VS Code by:
 * 1. Getting the "before" content from VCS (parent revision)
 * 2. Writing it to a temp file with a descriptive name
 * 3. `code --diff <before_temp> <current_file>`
 *
 * Works in both local and VS Code Remote environments because:
 * - Local: `code` opens files directly
 * - Remote: the remote CLI resolves paths on the remote filesystem
 *   and sends them to the local VS Code window
 */
async function openDiffInVSCode(
	pi: ExtensionAPI, ctx: ExtensionContext,
	file: FileEntry, vcs: VCS, codeCli: string,
): Promise<void> {
	const basename = path.basename(file.path);
	const ext = path.extname(basename);
	const stem = ext ? basename.slice(0, -ext.length) : basename;

	// Get "before" content from VCS parent
	let beforeContent: string;
	if (vcs === "jj") {
		const r = await pi.exec(
			"jj", ["file", "show", "-r", "@-", "--no-pager", file.display],
			{ cwd: ctx.cwd, timeout: 10000 },
		);
		beforeContent = r.code === 0 ? r.stdout : "";
	} else {
		const r = await pi.exec(
			"git", ["show", `HEAD:${file.display}`],
			{ cwd: ctx.cwd, timeout: 10000 },
		);
		beforeContent = r.code === 0 ? r.stdout : "";
	}

	// Write "before" to a descriptive temp file
	const tmpFile = path.join(os.tmpdir(), `${stem} (before)${ext}`);
	writeFileSync(tmpFile, beforeContent, "utf8");

	// Open diff in VS Code
	await pi.exec(codeCli, ["--diff", tmpFile, file.path], { timeout: 10000 });

	// Clean up after VS Code has had time to read the file
	setTimeout(() => {
		try { unlinkSync(tmpFile); } catch {}
	}, 5000);
}

// ── Action Menu ────────────────────────────────────────────────────────────

async function showActions(
	pi: ExtensionAPI, ctx: ExtensionContext, file: FileEntry, vcs: VCS,
): Promise<void> {
	const codeCli = await findCodeCli(pi);

	const actions: SelectItem[] = [
		{ value: "add", label: "Add to prompt" },
		{ value: "open", label: "Open (default app)" },
		{ value: "reveal", label: "Reveal in Finder" },
	];

	if (file.status && file.exists && codeCli) {
		actions.unshift({ value: "diff", label: "Diff in VS Code" });
	}

	const choice = await notifyBeforePrompt(
		`File actions: ${file.display}`,
		() => ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(new Text(
				` ${theme.fg("accent", theme.bold(file.display))}`, 0, 0,
			));

			const list = new SelectList(actions, actions.length, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", " Enter confirm · Esc cancel"), 0, 0));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
			};
		}),
	);

	if (!choice) return;

	switch (choice) {
		case "add":
			ctx.ui.pasteToEditor(file.display);
			break;
		case "open":
			await pi.exec("open", [file.path]);
			break;
		case "reveal":
			await pi.exec("open", ["-R", file.path]);
			break;
		case "diff": {
			if (!codeCli) break;
			await openDiffInVSCode(pi, ctx, file, vcs, codeCli);
			break;
		}
	}
}

// ── File Picker TUI ────────────────────────────────────────────────────────

async function showFilePicker(
	ctx: ExtensionContext, files: FileEntry[],
): Promise<FileEntry | null> {
	return notifyBeforePrompt("Browse files", () => ctx.ui.custom<FileEntry | null>((tui, theme, _kb, done) => {
		const input = new Input();
		let query = "";
		let filtered = files;
		let selectedIdx = 0;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		const MAX_VISIBLE = 20;

		function refilter() {
			if (!query) {
				filtered = files;
			} else {
				// Simple fuzzy: filter files whose display path contains all query chars in order
				filtered = files.filter((f) => {
					let qi = 0;
					for (const ch of f.display) {
						if (qi < query.length && ch.toLowerCase() === query[qi].toLowerCase()) qi++;
					}
					return qi === query.length;
				});
			}
			selectedIdx = 0;
			invalidate();
		}

		function invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const t = theme;

			// Search input
			lines.push(t.fg("accent", "─".repeat(width)));
			lines.push(` ${t.fg("dim", "Search:")} ${query}${t.fg("dim", "│")}`);
			lines.push(t.fg("accent", "─".repeat(width)));

			// File list
			const start = Math.max(0, selectedIdx - Math.floor(MAX_VISIBLE / 2));
			const end = Math.min(filtered.length, start + MAX_VISIBLE);

			if (filtered.length === 0) {
				lines.push(t.fg("warning", "  No files match"));
			}

			for (let i = start; i < end; i++) {
				const f = filtered[i];
				const selected = i === selectedIdx;
				const pointer = selected ? t.fg("accent", "> ") : "  ";

				let badge = "  ";
				if (f.status) badge = t.fg("warning", f.status.padEnd(2));
				else if (f.hasSessionChange) badge = t.fg("success", "★ ");
				else if (f.isReferenced) badge = t.fg("muted", "◆ ");

				const name = selected ? t.fg("accent", f.display) : f.display;
				lines.push(`${pointer}${badge} ${name}`);
			}

			if (filtered.length > MAX_VISIBLE) {
				lines.push(t.fg("dim", `  … ${filtered.length - MAX_VISIBLE} more`));
			}

			lines.push("");
			lines.push(t.fg("dim", " ↑↓ nav · Enter select · Esc cancel"));
			lines.push(t.fg("accent", "─".repeat(width)));

			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done(null);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(filtered[selectedIdx] ?? null);
				return;
			}
			if (matchesKey(data, Key.up)) {
				selectedIdx = Math.max(0, selectedIdx - 1);
				invalidate();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIdx = Math.min(filtered.length - 1, selectedIdx + 1);
				invalidate();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				if (query.length > 0) {
					query = query.slice(0, -1);
					refilter();
					tui.requestRender();
				}
				return;
			}
			// Printable char
			if (data.length === 1 && data >= " ") {
				query += data;
				refilter();
				tui.requestRender();
			}
		}

		return { render, invalidate, handleInput };
	}));
}

// ── Extension Entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	async function handler(dirtyOnly: boolean, ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Requires interactive mode", "error");
			return;
		}

		const { files, vcs } = await buildFileEntries(pi, ctx, dirtyOnly);
		if (files.length === 0) {
			ctx.ui.notify(dirtyOnly ? "No dirty files" : "No files found", "info");
			return;
		}

		const selected = await showFilePicker(ctx, files);
		if (!selected) return;

		await showActions(pi, ctx, selected, vcs);
	}

	pi.registerCommand("files", {
		description: "Browse project files with fuzzy search",
		handler: (_args, ctx) => handler(false, ctx),
	});

	pi.registerCommand("diff", {
		description: "Browse dirty (modified) files",
		handler: (_args, ctx) => handler(true, ctx),
	});
}
