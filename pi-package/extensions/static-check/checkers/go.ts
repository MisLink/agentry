/**
 * Go checker — prefers `golangci-lint run` when available, falls back to `go vet`.
 *
 * Both tools output structured JSON, which is more reliable than parsing
 * line-based text formats.
 *
 * Detection order:
 *   1. golangci-lint on system PATH
 *   2. go vet (always available when go.mod exists)
 */

import { access, constants } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { findSystemBin } from "../tool-finder.js";
import { makeDiagnostic, type Diagnostic, type LanguageChecker, type ToolSpec } from "../types.js";

const GOLANGCI_LINT_CONFIGS = [
	".golangci.yml",
	".golangci.yaml",
	".golangci.toml",
	".golangci.json",
];

async function hasGolangciConfig(projectRoot: string): Promise<boolean> {
	for (const name of GOLANGCI_LINT_CONFIGS) {
		try {
			await access(join(projectRoot, name), constants.R_OK);
			return true;
		} catch {
			// continue
		}
	}
	return false;
}

// ── golangci-lint JSON parsing ─────────────────────────────────────────────

interface GolangciIssue {
	FromLinter: string;
	Text: string;
	Severity?: string;
	Pos: { Filename: string; Line: number; Column: number };
}

interface GolangciOutput {
	Issues?: GolangciIssue[];
}

/**
 * Parse golangci-lint JSON output.
 * With --output.json.path=stdout --output.text.path=, stdout should be
 * a single JSON object. We try JSON.parse directly — no manual brace matching.
 */
function parseGolangciJson(stdout: string, projectRoot: string): Diagnostic[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];

	let data: GolangciOutput;
	try {
		data = JSON.parse(trimmed);
	} catch {
		return [];
	}

	if (!data.Issues?.length) return [];

	return data.Issues.map((issue) => {
		const file = isAbsolute(issue.Pos.Filename)
			? relative(projectRoot, issue.Pos.Filename)
			: issue.Pos.Filename;

		const severity = issue.Severity === "warning" ? "warning" as const : "error" as const;
		const text = `${issue.Text} (${issue.FromLinter})`;

		return makeDiagnostic(
			file.replace(/\\/g, "/"),
			issue.Pos.Line,
			issue.Pos.Column || 1,
			text,
			severity,
		);
	});
}

// ── go vet -json parsing ───────────────────────────────────────────────────

interface GoVetDiagnostic {
	posn: string;
	message: string;
}

/**
 * go vet -json outputs NDJSON — one JSON object per package:
 *   {"pkg1":{"analyzerName":[{"posn":"file.go:10:5","message":"..."}]}}
 *   {"pkg2":{"analyzerName":[...]}}
 *
 * We parse each line independently and merge results.
 */
function parseGoVetJson(stdout: string, projectRoot: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.startsWith("{")) continue;

		let data: Record<string, Record<string, GoVetDiagnostic[]>>;
		try {
			data = JSON.parse(trimmed);
		} catch {
			continue;
		}

		for (const pkgAnalyzers of Object.values(data)) {
			if (typeof pkgAnalyzers !== "object" || pkgAnalyzers === null) continue;
			for (const issues of Object.values(pkgAnalyzers)) {
				if (!Array.isArray(issues)) continue;
				for (const issue of issues) {
					if (!issue.posn || !issue.message) continue;
					// posn format: "/abs/path/file.go:10:5" or "file.go:10:5"
					const match = issue.posn.match(/^(.+?):(\d+):(\d+)$/);
					if (!match) continue;

					const [, rawFile, lineStr, colStr] = match;
					const file = isAbsolute(rawFile)
						? relative(projectRoot, rawFile)
						: rawFile;

					diagnostics.push(
						makeDiagnostic(
							file.replace(/\\/g, "/"),
							parseInt(lineStr, 10),
							parseInt(colStr, 10),
							issue.message,
						),
					);
				}
			}
		}
	}

	return diagnostics;
}

// ── Checker implementation ─────────────────────────────────────────────────

export const goChecker: LanguageChecker = {
	id: "go",
	name: "Go",
	extensions: [".go"],
	configFiles: ["go.mod"],

	async detectTool(projectRoot) {
		const golangci = await findSystemBin("golangci-lint");
		if (golangci) {
			const hasConfig = await hasGolangciConfig(projectRoot);
			return {
				...golangci,
				toolId: "golangci-lint",
				displayName: hasConfig ? "golangci-lint (with config)" : "golangci-lint",
			};
		}
		return await findSystemBin("go");
	},

	buildArgs(_projectRoot, tool) {
		if (tool.toolId === "golangci-lint") {
			// JSON to stdout, suppress default text output
			return [
				"run",
				"--output.json.path=stdout",
				"--output.text.path=",
				"--timeout=1m",
				"./...",
			];
		}
		return ["vet", "-json", "./..."];
	},

	parseOutput(stdout, stderr, exitCode, projectRoot) {
		if (exitCode === 0) return [];

		// golangci-lint: detect by stdout content (JSON goes to stdout only)
		if (stdout.includes('"FromLinter"') || stdout.includes('"Issues"')) {
			return parseGolangciJson(stdout, projectRoot);
		}

		// go vet -json: NDJSON on stdout, parse line by line
		if (stdout.trim()) {
			const parsed = parseGoVetJson(stdout, projectRoot);
			if (parsed.length > 0) return parsed;
		}

		// Fallback: line-based regex on both stdout and stderr
		const output = [stdout, stderr].filter(Boolean).join("\n");
		const diagnostics: Diagnostic[] = [];
		const re = /^(?:\.\/)?(.+?):(\d+):(\d+):\s+(.+)$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(output)) !== null) {
			const [, file, line, col, msg] = m;
			if (file.startsWith("#")) continue;
			diagnostics.push(
				makeDiagnostic(
					file.replace(/\\/g, "/"),
					parseInt(line, 10),
					parseInt(col, 10),
					msg.trim(),
				),
			);
		}
		return diagnostics;
	},
};
