import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installCandidateWheels } from "./candidate-wheel-install.js";
import { resolveCandidateWheelSet } from "./candidate-wheel-resolver.js";

it("目录字节漂移拒绝", async () => {
	await expect(
		resolveCandidateWheelSet({
			bundle: Buffer.from("x"),
			sha256: "0".repeat(64),
			requirements: ["candidate==1.0"],
		}),
	).rejects.toThrow("CANDIDATE_HASH_MISMATCH");
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"固定 pip 的真实离线版本求解",
	() => {
		it.each([
			"highest",
			"backtrack",
			"extras",
			"conflict",
			"direct",
			"root-url",
		])(
			"%s",
			async (mode) => {
				const { stdout } = await promisify(execFile)(
					fileURLToPath(
						new URL(
							"../../../services/data-worker/.venv/Scripts/python.exe",
							import.meta.url,
						),
					),
					[
						"-I",
						fileURLToPath(
							new URL(
								"../../../scripts/adapter-candidate/resolver_fixture.py",
								import.meta.url,
							),
						),
						mode,
					],
					{ encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
				);
				const bundle = Buffer.from(stdout.trim(), "base64");
				const requirements =
					mode === "root-url"
						? ["candidate @ file:///work/private.whl"]
						: mode === "extras"
							? ["candidate[speed]==1.0"]
							: mode === "highest" || mode === "direct"
								? ["candidate==1.0"]
								: ["candidate==1.0", "other==1.0"];
				const operation = resolveCandidateWheelSet({
					bundle,
					sha256: createHash("sha256").update(bundle).digest("hex"),
					requirements,
				});
				if (["conflict", "direct", "root-url"].includes(mode)) {
					await expect(operation).rejects.toThrow(
						"CANDIDATE_RESOLUTION_FAILED",
					);
					return;
				}
				const result = await operation;
				expect(result.pipVersion).toBe("26.1.2");
				expect(result.reviewStatus).toBe("NOT_RUN");
				expect(
					result.locked.find((item) => item.name === "helper")?.version,
				).toBe(mode === "backtrack" ? "1.0" : "2.0");
				expect(result.locked.some((item) => item.name === "fast")).toBe(
					mode === "extras",
				);
				expect(result.locked.some((item) => item.name === "absent")).toBe(
					false,
				);
				const installed = await installCandidateWheels({
					bundle: result.bundle,
					sha256: result.sha256,
					locked: result.locked,
				});
				expect(installed.execution.exitCode).toBe(0);
				expect(installed.execution.reviewStatus).toBe("NOT_RUN");
			},
			40_000,
		);
	},
);
