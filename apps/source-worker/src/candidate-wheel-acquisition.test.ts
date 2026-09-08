import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireCandidateWheelBundle } from "./candidate-wheel-acquisition.js";
import { reviewCandidateWheelDependencies } from "./candidate-wheel-review.js";

vi.mock("./candidate-vulnerability-scan.js", () => ({
	scanCandidateVulnerabilities: vi.fn(async () => ({
		status: "PASSED",
		findingCount: 0,
	})),
}));
afterEach(() => vi.unstubAllGlobals());
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

it.each(["invalid", "cancelled"])("自动审查 %s 不获取或写入", async (mode) => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const store = { saveArtifact: vi.fn(), record: vi.fn() };
	await expect(
		reviewCandidateWheelDependencies(
			{
				requirement: {
					packageName: mode === "invalid" ? "../escape" : "candidate",
					specifier: "==1.0",
					extras: [],
				},
				...(mode === "cancelled" ? { signal: AbortSignal.abort() } : {}),
			},
			store,
		),
	).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
	expect(store.saveArtifact).not.toHaveBeenCalled();
	expect(store.record).not.toHaveBeenCalled();
});

it("重复规范包名在下载前拒绝", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const source = {
		kind: "PYPI",
		packageName: "candidate",
		version: "1.0",
		artifactSha256: "0".repeat(64),
	};
	await expect(
		acquireCandidateWheelBundle([
			{ source, filename: "candidate-1.0-py3-none-any.whl" },
			{ source, filename: "candidate-1.0-py2-none-any.whl" },
		]),
	).rejects.toThrow("CANDIDATE_WHEEL_SET_INVALID");
	expect(fetch).not.toHaveBeenCalled();
});

describe.runIf(
	process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1" &&
		process.env.CHOICEMIND_TEST_DATABASE_URL !== undefined,
)("获取集合贯通真实隔离安装审查", () => {
	it.each([
		"invoke-success",
		"missing",
		"changed",
		"renamed",
		"auto",
		"auto-changed",
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
							"../../../scripts/adapter-candidate/wheel_fixture.py",
							import.meta.url,
						),
					),
					mode === "changed" || mode === "renamed" || mode.startsWith("auto")
						? "invoke-success"
						: mode,
				],
				{ encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
			);
			const fixture = JSON.parse(stdout) as {
				locked: {
					name: string;
					version: string;
					filename: string;
					sha256: string;
				}[];
				wheels: { filename: string; bytes: string }[];
			};
			const files = fixture.locked.map((lock) => ({
				source: {
					kind: "PYPI",
					packageName: lock.name,
					version: lock.version,
					artifactSha256: lock.sha256,
				},
				filename: lock.filename,
			}));
			if (mode === "renamed" && files[0])
				files[0].filename = "candidate-1.0-py2-none-any.whl";
			let rootDownloads = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) => {
					const metadata = url.startsWith("https://pypi.org/");
					if (
						mode.startsWith("auto") &&
						/^https:\/\/pypi.org\/pypi\/[^/]+\/json$/.test(url)
					) {
						const item = fixture.locked.find((lock) =>
							url.includes(`/pypi/${lock.name}/`),
						);
						if (!item) throw new Error("SYNTHETIC_INDEX_MISSING");
						return Response.json({
							info: { name: item.name },
							releases: {
								[item.version]: [
									{
										filename: item.filename,
										packagetype: "bdist_wheel",
										yanked: false,
										requires_python: ">=3.10",
										digests: { sha256: item.sha256 },
									},
								],
							},
						});
					}
					const item = fixture.locked.find((lock) =>
						metadata
							? url.includes(`/pypi/${lock.name}/`)
							: url.endsWith(`/${lock.filename}`),
					);
					if (!item) throw new Error("UNEXPECTED_PUBLIC_REQUEST");
					if (metadata)
						return Response.json({
							info: { name: item.name, version: item.version },
							urls: [
								{
									filename: item.filename,
									url: `https://files.pythonhosted.org/packages/aa/${item.filename}`,
									digests: { sha256: item.sha256 },
								},
							],
						});
					const wheel = fixture.wheels.find(
						(wheel) => wheel.filename === item.filename,
					);
					if (!wheel) throw new Error("SYNTHETIC_WHEEL_MISSING");
					if (item.name === "candidate") rootDownloads++;
					if (
						mode === "auto-changed" &&
						item.name === "candidate" &&
						rootDownloads > 1
					)
						return new Response("changed");
					return new Response(
						mode === "changed" ? "changed" : Buffer.from(wheel.bytes, "base64"),
					);
				}),
			);
			if (mode.startsWith("auto")) {
				let store = await openPostgresCandidateStore(
					process.env.CHOICEMIND_TEST_DATABASE_URL ?? "",
				);
				try {
					const save = vi.spyOn(store, "saveArtifact");
					const record = vi.spyOn(store, "record");
					const operation = reviewCandidateWheelDependencies(
						{
							requirement: {
								packageName: "candidate",
								specifier: "==1.0",
								extras: [],
							},
						},
						store,
					);
					if (mode === "auto-changed") {
						await expect(operation).rejects.toThrow(
							"CANDIDATE_ACQUISITION_REJECTED",
						);
						expect(save).not.toHaveBeenCalled();
						expect(record).not.toHaveBeenCalled();
						return;
					}
					const { report, stored } = await operation;
					expect(report.schemaVersion).toBe(
						"candidate-wheel-dependency-review.v5",
					);
					expect(report.provenance?.locked).toEqual(fixture.locked);
					expect(report.provenance?.acquisitions).toHaveLength(2);
					expect(stored.candidate.review.checks.dependencies.status).toBe(
						"PASSED",
					);
					expect(stored.candidate.review.checks.entrypoints.status).toBe(
						"PASSED",
					);
					expect(stored.lifecycle.state).toBe("REVIEW_FAILED");
					expect(save).toHaveBeenCalledTimes(1);
					const reportBytes = save.mock.calls[0]?.[0];
					if (!reportBytes) throw new Error("REPORT_MISSING");
					expect(JSON.parse(Buffer.from(reportBytes).toString("utf8"))).toEqual(
						report,
					);
					expect(hash(reportBytes)).toBe(stored.candidate.review.reportSha256);
					await store.close();
					store = await openPostgresCandidateStore(
						process.env.CHOICEMIND_TEST_DATABASE_URL ?? "",
					);
					expect(await store.read(stored.candidate.candidateId)).toEqual(
						stored,
					);
				} finally {
					await store.close();
				}
				return;
			}
			if (mode === "changed" || mode === "renamed") {
				await expect(acquireCandidateWheelBundle(files)).rejects.toThrow(
					mode === "changed"
						? "CANDIDATE_ACQUISITION_REJECTED"
						: "CANDIDATE_WHEEL_FILENAME_MISMATCH",
				);
				return;
			}
			const first = await acquireCandidateWheelBundle(files);
			const second = await acquireCandidateWheelBundle([...files].reverse());
			expect(first.sha256).toBe(second.sha256);
			expect(first.locked).toEqual(second.locked);
			expect(first.acquisitions).toHaveLength(files.length);
			expect(first.reviewStatus).toBe("NOT_RUN");
			expect(first.execution.reviewStatus).toBe("NOT_RUN");
			expect(first.sha256).toBe(hash(first.bundle));
			const target = fixture.wheels.find((item) =>
				item.filename.startsWith("candidate-"),
			);
			if (!target) throw new Error("SYNTHETIC_TARGET_MISSING");
			const store = await openPostgresCandidateStore(
				process.env.CHOICEMIND_TEST_DATABASE_URL ?? "",
			);
			try {
				const { stored, report } = await reviewCandidateWheelDependencies(
					{
						source: {
							kind: "PYPI",
							packageName: "candidate",
							version: "1.0",
							artifactSha256: hash(Buffer.from(target.bytes, "base64")),
						},
						artifact: Buffer.from(target.bytes, "base64"),
						bundle: first.bundle,
						locked: first.locked,
					},
					store,
				);
				expect(report.bundleSha256).toBe(first.sha256);
				expect(stored.candidate.review.checks.dependencies.status).toBe(
					mode === "missing" ? "FAILED" : "PASSED",
				);
				expect(stored.candidate.review.checks.entrypoints.status).toBe(
					mode === "missing" ? "NOT_RUN" : "PASSED",
				);
				expect(stored.lifecycle.state).toBe("REVIEW_FAILED");
			} finally {
				await store.close();
			}
		},
		120_000,
	);
});
