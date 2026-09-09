import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPypiProjectMetadata } from "./candidate-acquisition.js";
import { resolvePublicPypiClosure } from "./candidate-pypi-closure.js";
import { installCandidateWheels } from "./candidate-wheel-install.js";

afterEach(() => vi.unstubAllGlobals());

it.each([404, 503])("项目响应 %s 不混淆不存在与服务故障", async (status) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status })),
	);
	await expect(readPypiProjectMetadata("missing")).rejects.toThrow(
		status === 404
			? "CANDIDATE_PROJECT_NOT_FOUND"
			: "CANDIDATE_INDEX_UNAVAILABLE",
	);
});

it("非法根需求在获取前拒绝", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		resolvePublicPypiClosure([
			{ packageName: "../escape", specifier: "==1", extras: [] },
		]),
	).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"索引到锁定安装的完整合成依赖图",
	() => {
		it.each(["normal", "conflict", "direct", "missing"])(
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
						"--catalogue",
					],
					{ encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
				);
				const wheels = JSON.parse(stdout) as {
					name: string;
					version: string;
					filename: string;
					sha256: string;
					bytes: string;
				}[];
				const wireFile = (file: (typeof wheels)[number]) => ({
					filename: file.filename,
					packagetype: "bdist_wheel",
					digests: { sha256: file.sha256 },
					url: `https://files.pythonhosted.org/packages/aa/${file.filename}`,
					yanked: false,
					requires_python: ">=3.10",
				});
				const fetch = vi.fn(async (input: string) => {
					const url = new URL(input);
					if (url.hostname === "files.pythonhosted.org") {
						const file = wheels.find((file) =>
							url.pathname.endsWith(`/${file.filename}`),
						);
						if (!file) throw new Error("UNEXPECTED_WHEEL");
						return new Response(Buffer.from(file.bytes, "base64"));
					}
					const segments = url.pathname.split("/");
					const name = segments[2];
					if (name === "missing") return new Response(null, { status: 404 });
					const version = segments[3] === "json" ? undefined : segments[3];
					const candidates = wheels.filter(
						(file) =>
							file.name === name && (!version || file.version === version),
					);
					if (url.hostname !== "pypi.org" || candidates.length === 0)
						throw new Error("UNEXPECTED_INDEX");
					return Response.json(
						version
							? { info: { name, version }, urls: candidates.map(wireFile) }
							: {
									info: { name },
									releases: Object.fromEntries(
										candidates.map((file) => [file.version, [wireFile(file)]]),
									),
								},
					);
				});
				vi.stubGlobal("fetch", fetch);
				const operation = resolvePublicPypiClosure([
					{ packageName: "candidate", specifier: "==1.0", extras: ["speed"] },
					{ packageName: "other", specifier: "==1.0", extras: [] },
				]);
				if (mode === "conflict" || mode === "direct") {
					await expect(operation).rejects.toThrow(
						mode === "direct"
							? "CANDIDATE_METADATA_REJECTED"
							: "CANDIDATE_RESOLUTION_FAILED",
					);
					return;
				}
				const result = await operation;
				expect(result.missingProjects).toEqual(
					mode === "missing" ? ["missing"] : [],
				);
				expect(
					result.locked.map((item) => `${item.name}==${item.version}`),
				).toEqual(["candidate==1.0", "fast==1.0", "helper==1.0", "other==1.0"]);
				expect(result.acquisitions).toHaveLength(5);
				expect(fetch.mock.calls.some(([url]) => url.includes("/absent/"))).toBe(
					false,
				);
				const installed = await installCandidateWheels({
					bundle: result.bundle,
					sha256: result.sha256,
					locked: result.locked,
				});
				expect(installed.execution.exitCode).toBe(0);
				expect(result.reviewStatus).toBe("NOT_RUN");
			},
			120_000,
		);
	},
);
