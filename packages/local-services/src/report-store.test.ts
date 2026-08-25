import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveLocalServiceSmokeReport } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("saveLocalServiceSmokeReport", () => {
	it("以 UTF-8 原子写入报告且不遗留临时文件", async () => {
		const directory = await mkdtemp(
			path.join(os.tmpdir(), "choicemind-local-smoke-"),
		);
		temporaryDirectories.push(directory);
		const reportPath = path.join(directory, "nested", "report.json");
		const report = {
			contractType: "local-service-smoke-report",
			contractVersion: "1.0",
			status: "SMOKE_FAILED",
			executedAt: "2026-08-24T08:00:00.000Z",
			services: [],
		} as const;

		await saveLocalServiceSmokeReport(reportPath, report);

		expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
		expect(await readdir(path.dirname(reportPath))).toEqual(["report.json"]);
	});
});
