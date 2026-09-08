import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installCandidateWheels } from "./candidate-wheel-install.js";

it("空锁清单不能启动安装", async () => {
	await expect(
		installCandidateWheels({
			bundle: Buffer.from("x"),
			sha256: "0".repeat(64),
			locked: [],
		}),
	).rejects.toThrow("CANDIDATE_WHEEL_INPUT_INVALID");
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"受监督离线 wheel 安装",
	() => {
		it.each([
			"complete",
			"missing",
			"hash",
			"injection",
			"source-success",
			"source-failure",
			"source-missing",
			"source-shadow",
			"source-ambient",
		])(
			"%s",
			async (mode) => {
				const python = fileURLToPath(
					new URL(
						"../../../services/data-worker/.venv/Scripts/python.exe",
						import.meta.url,
					),
				);
				const fixture = fileURLToPath(
					new URL(
						"../../../scripts/adapter-candidate/wheel_fixture.py",
						import.meta.url,
					),
				);
				const { stdout } = await promisify(execFile)(
					python,
					["-I", fixture, mode],
					{ encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
				);
				const generated = JSON.parse(stdout);
				if (mode === "hash") generated.locked[0].sha256 = "0".repeat(64);
				if (mode === "injection")
					generated.locked[0].name =
						"candidate\n--index-url=https://example.com";
				const bundle = Buffer.from(generated.bundle, "base64");
				const source =
					generated.source === null
						? undefined
						: Buffer.from(generated.source, "base64");
				const result = installCandidateWheels({
					bundle,
					sha256: createHash("sha256").update(bundle).digest("hex"),
					locked: generated.locked,
					...(source === undefined
						? {}
						: {
								source: {
									archive: source,
									sha256: createHash("sha256").update(source).digest("hex"),
								},
							}),
				});
				if (
					mode === "complete" ||
					mode === "source-success" ||
					mode === "source-shadow"
				) {
					await expect(result).resolves.toMatchObject({
						summary: {
							installed: true,
							lockedWheels: 2,
							...(mode === "source-success"
								? {
										build: {
											status: "BUILD_EXITED",
											wheelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
											reviewStatus: "NOT_RUN",
											runtimeDependencies: "NOT_RUN",
										},
									}
								: {}),
							reviewStatus: "NOT_RUN",
						},
						execution: { exitCode: 0, reviewStatus: "NOT_RUN" },
					});
				} else {
					await expect(result).rejects.toThrow(
						"CANDIDATE_WHEEL_INSTALL_REJECTED",
					);
				}
			},
			40_000,
		);
	},
);
