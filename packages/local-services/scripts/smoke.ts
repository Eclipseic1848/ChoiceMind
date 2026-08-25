import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	loadLocalServiceConfiguration,
	runLocalServiceSmoke,
	saveLocalServiceSmokeReport,
} from "../src/index.js";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const reportPath =
	process.env.CHOICEMIND_LOCAL_SMOKE_REPORT_PATH ??
	path.resolve(packageRoot, "../../.artifacts/p0-10-local-services-smoke.json");
const report = await runLocalServiceSmoke(
	loadLocalServiceConfiguration(process.env),
);

await saveLocalServiceSmokeReport(reportPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "SMOKE_PASSED") {
	process.exitCode = 1;
}
