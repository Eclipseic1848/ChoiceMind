import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalServiceSmokeReportV1 } from "./smoke.js";

export async function saveLocalServiceSmokeReport(
	reportPath: string,
	report: LocalServiceSmokeReportV1,
): Promise<void> {
	const directory = path.dirname(reportPath);
	const temporaryPath = `${reportPath}.${process.pid}.tmp`;
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(
			temporaryPath,
			`${JSON.stringify(report, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, reportPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
