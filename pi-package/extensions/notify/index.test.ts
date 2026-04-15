import assert from "node:assert/strict";
import test from "node:test";

import * as notifyModule from "./index.ts";
import { buildPayload, getKittyEscapeCode, shouldSendNotification } from "./index.ts";
import { detectFocusMode, focusStatusIcon, resolveFocusMode } from "./focus-mode.ts";

type KittyExecOptions = { encoding: "utf8"; timeout: number };
type CommandExecOptions = { encoding: "utf8"; timeout: number };

test("buildPayload returns null when there is no final assistant text", () => {
	assert.equal(buildPayload(null), null);
	assert.equal(buildPayload("   \n\t  "), null);
});

test("getKittyEscapeCode runs kitten in escape-code mode and returns stdout", () => {
	let captured:
		| {
				file: string;
				args: string[];
				options: KittyExecOptions;
		  }
		| undefined;
	const escapeCode = "\u001b]99;i=test;\u001b\\";

	const result = getKittyEscapeCode(
		"π",
		"Ready for input",
		(file: string, args: string[], options: KittyExecOptions) => {
			captured = { file, args, options };
			return escapeCode;
		},
	);

	assert.equal(result, escapeCode);
	assert.deepEqual(captured, {
		file: "kitten",
		args: [
			"notify",
			"--only-print-escape-code",
			"--app-name=pi",
			"--type=pi-agent-ready",
			"--urgency=normal",
			"--expire-after=30s",
			"π",
			"Ready for input",
		],
		options: { encoding: "utf8", timeout: 5000 },
	});
});

test("getKittyEscapeCode returns null when kitten command fails", () => {
	const result = getKittyEscapeCode("π", "Ready", () => {
		throw new Error("spawn failed");
	});

	assert.equal(result, null);
});

test("shouldSendNotification suppresses notify when current Kitty window is focused", () => {
	const result = shouldSendNotification(
		{
			KITTY_WINDOW_ID: "42",
			KITTY_LISTEN_ON: "unix:/tmp/kitty.sock",
		},
		"darwin",
		(command: string, args: string[], _options: CommandExecOptions) => {
			assert.equal(command, "kitten");
			assert.deepEqual(args, ["@", "--to", "unix:/tmp/kitty.sock", "ls", "--match", "state:focused"]);
			return JSON.stringify([
				{
					tabs: [
						{
							windows: [{ id: 42, is_focused: true, cmdline: ["pi"], cwd: "/tmp" }],
						},
					],
				},
			]);
		},
	);

	assert.equal(result, false);
});

test("shouldSendNotification does not suppress when current Kitty window is present but unfocused", () => {
	const result = shouldSendNotification(
		{
			KITTY_WINDOW_ID: "42",
			KITTY_LISTEN_ON: "unix:/tmp/kitty.sock",
		},
		"darwin",
		(_command: string, _args: string[], _options: CommandExecOptions) =>
			JSON.stringify([
				{
					tabs: [
						{
							windows: [{ id: 42, is_focused: false, cmdline: ["pi"], cwd: "/tmp" }],
						},
					],
				},
			]),
	);

	assert.equal(result, true);
});

test("shouldSendNotification notifies when another Kitty window is focused", () => {
	const result = shouldSendNotification(
		{
			KITTY_WINDOW_ID: "42",
			KITTY_LISTEN_ON: "unix:/tmp/kitty.sock",
		},
		"darwin",
		(_command: string, _args: string[], _options: CommandExecOptions) =>
			JSON.stringify([
				{
					tabs: [
						{
							windows: [{ id: 7, cmdline: ["shell"], cwd: "/tmp" }],
						},
					],
				},
			]),
	);

	assert.equal(result, true);
});

test("shouldSendNotification falls back to macOS frontmost-app detection when Kitty socket state is unavailable", () => {
	const result = shouldSendNotification(
		{
			KITTY_WINDOW_ID: "42",
		},
		"darwin",
		(command: string, args: string[], _options: CommandExecOptions) => {
			assert.equal(command, "osascript");
			assert.deepEqual(args, [
				"-e",
				'tell application "System Events" to get name of first application process whose frontmost is true',
			]);
			return "kitty\n";
		},
	);

	assert.equal(result, false);
});

test("buildAttentionPayload prefixes prompt title for action-needed notifications", () => {
	const fn = (notifyModule as { buildAttentionPayload?: (promptTitle: string) => { title: string; body: string } })
		.buildAttentionPayload;

	assert.equal(typeof fn, "function");
	assert.deepEqual(fn?.("如何执行？"), {
		title: "π",
		body: "Waiting for input: 如何执行？",
	});
});

test("notifyBeforePrompt sends attention notification before awaiting user input", async () => {
	const fn = (notifyModule as {
		notifyBeforePrompt?: <T>(
			promptTitle: string,
			waitForUser: () => Promise<T>,
			send: (title: string, body: string) => void,
		) => Promise<T>;
	}).notifyBeforePrompt;

	assert.equal(typeof fn, "function");

	const calls: string[] = [];
	const result = await fn?.(
		"选择基础分支：",
		async () => {
			calls.push("wait");
			return "main";
		},
		(title: string, body: string) => {
			calls.push(`${title}|${body}`);
		},
	);

	assert.equal(result, "main");
	assert.deepEqual(calls, ["π|Waiting for input: 选择基础分支：", "wait"]);
});

test("resolveFocusMode recognizes active and inactive focus states", () => {
	const activeAssertions = JSON.stringify({
		data: [{
			storeAssertionRecords: [{
				assertionStartDateTimestamp: 2,
				assertionDetails: { assertionDetailsModeIdentifier: "work-mode" },
			}],
		}],
	});
	const configs = JSON.stringify({
		data: [{
			modeConfigurations: {
				"work-mode": { mode: { name: "Work" } },
			},
		}],
	});
	const inactiveAssertions = JSON.stringify({ data: [{ storeAssertionRecords: [] }] });

	assert.deepEqual(resolveFocusMode(activeAssertions, configs), { status: "active", name: "Work" });
	assert.deepEqual(resolveFocusMode(inactiveAssertions, configs), { status: "inactive" });
});

test("detectFocusMode reports unavailable on permission errors", async () => {
	const result = await detectFocusMode(async () => {
		throw new Error("Error: File permission error. (-54)");
	});

	assert.deepEqual(result, { status: "unavailable", reason: "permission-denied" });
});

test("focusStatusIcon shows moon only for active focus mode", () => {
	assert.equal(focusStatusIcon({ status: "active", name: "Work" }), "🌙");
	assert.equal(focusStatusIcon({ status: "inactive" }), null);
	assert.equal(focusStatusIcon({ status: "unavailable", reason: "permission-denied" }), null);
});
