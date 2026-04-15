import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type FocusModeState =
	| { status: "active"; name: string }
	| { status: "inactive" }
	| { status: "unavailable"; reason: "permission-denied" | "command-failed" | "unsupported" };

export type FocusModeReader = () => Promise<{
	assertionsJson: string;
	modeConfigurationsJson: string;
}>;

type AssertionsFile = {
	data?: Array<{
		storeAssertionRecords?: Array<{
			assertionStartDateTimestamp?: number;
			assertionDetails?: {
				assertionDetailsModeIdentifier?: string;
			};
		}>;
	}>;
};

type ModeConfigurationsFile = {
	data?: Array<{
		modeConfigurations?: Record<string, { mode?: { name?: string } }>;
	}>;
};

async function readFocusModeFiles(): Promise<{
	assertionsJson: string;
	modeConfigurationsJson: string;
}> {
	const baseDir = join(homedir(), "Library", "DoNotDisturb", "DB");
	const [assertionsJson, modeConfigurationsJson] = await Promise.all([
		readFile(join(baseDir, "Assertions.json"), "utf8"),
		readFile(join(baseDir, "ModeConfigurations.json"), "utf8"),
	]);
	return { assertionsJson, modeConfigurationsJson };
}

export function resolveFocusMode(
	assertionsJson: string,
	modeConfigurationsJson: string,
): FocusModeState {
	const assertions = JSON.parse(assertionsJson) as AssertionsFile;
	const configurations = JSON.parse(modeConfigurationsJson) as ModeConfigurationsFile;

	const records = assertions.data?.[0]?.storeAssertionRecords ?? [];
	if (records.length === 0) return { status: "inactive" };

	const latest = [...records].sort(
		(a, b) => (b.assertionStartDateTimestamp ?? 0) - (a.assertionStartDateTimestamp ?? 0),
	)[0];
	const modeId = latest?.assertionDetails?.assertionDetailsModeIdentifier;
	if (!modeId) return { status: "inactive" };

	const name = configurations.data?.[0]?.modeConfigurations?.[modeId]?.mode?.name?.trim();
	if (!name) return { status: "inactive" };

	return { status: "active", name };
}

export async function detectFocusMode(read: FocusModeReader = readFocusModeFiles): Promise<FocusModeState> {
	if (process.platform !== "darwin") return { status: "unavailable", reason: "unsupported" };

	try {
		const { assertionsJson, modeConfigurationsJson } = await read();
		return resolveFocusMode(assertionsJson, modeConfigurationsJson);
	} catch (error) {
		const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
		if (
			message.includes("permission") ||
			message.includes("not permitted") ||
			message.includes("operation not permitted") ||
			message.includes("eacces") ||
			message.includes("eprem") ||
			message.includes("-54")
		) {
			return { status: "unavailable", reason: "permission-denied" };
		}
		return { status: "unavailable", reason: "command-failed" };
	}
}

export function focusStatusIcon(state: FocusModeState): string | null {
	return state.status === "active" ? "🌙" : null;
}
