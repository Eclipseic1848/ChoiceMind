import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	acquireCandidateArtifact,
	resolveCandidateArtifact,
} from "./candidate-acquisition.js";

const artifact = Buffer.from("synthetic archive bytes; never execute");

it.runIf(process.env.CHOICEMIND_RUN_PUBLIC_ACQUISITION === "1").each([
	{ kind: "NPM", packageName: "is-number", version: "7.0.0" },
	{
		kind: "GITHUB",
		repository: "pypa/sampleproject",
		commitSha: "621e4974ca25ce531773def586ba3ed8e736b3fc",
	},
])(
	"真实公开定位解析 %j",
	async (locator) => {
		const result = await resolveCandidateArtifact(locator);
		expect(result.receipt.source).toMatchObject(locator);
		expect(result.artifact.length).toBeGreaterThan(0);
		expect(result.artifact.length).toBeLessThan(1024 * 1024);
		expect(result.receipt.artifactSha256).toBe(hash(result.artifact));
		expect(result.receipt.reviewStatus).toBe("NOT_RUN");
	},
	100_000,
);

it.runIf(process.env.CHOICEMIND_RUN_PUBLIC_ACQUISITION === "1")(
	"真实 PyPI 固定小包只在内存核验",
	async () => {
		const result = await acquireCandidateArtifact({
			kind: "PYPI",
			packageName: "six",
			version: "1.17.0",
			artifactSha256:
				"4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274",
		});
		expect(result.artifact.length).toBe(11050);
		expect(result.receipt.reviewStatus).toBe("NOT_RUN");
	},
	100_000,
);
const hash = (value: Uint8Array, algorithm = "sha256") =>
	createHash(algorithm).update(value).digest("hex");
const sources = {
	GITHUB: {
		kind: "GITHUB",
		repository: "example/candidate",
		commitSha: "a".repeat(40),
		artifactSha256: hash(artifact),
	},
	NPM: {
		kind: "NPM",
		packageName: "@example/candidate",
		version: "1.0.0",
		artifactSha256: hash(artifact),
	},
	PYPI: {
		kind: "PYPI",
		packageName: "candidate",
		version: "1.0",
		artifactSha256: hash(artifact),
	},
} as const;
function metadata(kind: "NPM" | "PYPI", url?: string) {
	return kind === "NPM"
		? {
				name: "@example/candidate",
				version: "1.0.0",
				dist: {
					tarball:
						url ??
						"https://registry.npmjs.org/@example/candidate/-/candidate-1.0.0.tgz",
					integrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`,
				},
			}
		: {
				info: { name: "candidate", version: "1.0" },
				urls: [
					{
						filename: "candidate-1.0-py3-none-any.whl",
						url:
							url ?? "https://files.pythonhosted.org/packages/aa/candidate.whl",
						digests: { sha256: hash(artifact) },
					},
				],
			};
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it.each(["GITHUB", "NPM", "PYPI"] as const)(
	"%s 从精确定位解析身份，再获取时拒绝字节漂移",
	async (kind) => {
		const header = () =>
			kind === "GITHUB"
				? new Response(null, {
						status: 302,
						headers: {
							location: `https://codeload.github.com/example/candidate/legacy.tar.gz/${"a".repeat(40)}`,
						},
					})
				: Response.json(metadata(kind));
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(header())
			.mockResolvedValueOnce(new Response(artifact))
			.mockResolvedValueOnce(header())
			.mockResolvedValueOnce(new Response("changed"));
		vi.stubGlobal("fetch", fetch);
		const { artifactSha256: _, ...locator } = sources[kind];
		const result = await resolveCandidateArtifact({
			...locator,
			...(kind === "PYPI"
				? { filename: "candidate-1.0-py3-none-any.whl" }
				: {}),
		});
		expect(result.receipt.source).toEqual(sources[kind]);
		expect(result.receipt.identityOrigin).toBe("RESOLVED");
		expect(result.receipt.reviewStatus).toBe("NOT_RUN");
		await expect(
			acquireCandidateArtifact(result.receipt.source),
		).rejects.toThrow("CANDIDATE_ACQUISITION_REJECTED");
	},
);

it.each([
	{ kind: "GITHUB", repository: "example/candidate", commitSha: "main" },
	{ kind: "NPM", packageName: "candidate", version: "latest" },
	{ kind: "PYPI", packageName: "candidate", version: "1.0" },
	{
		kind: "PYPI",
		packageName: "candidate",
		version: "1.0",
		filename: "../escape.whl",
	},
	sources.NPM,
])("非法解析定位不得发请求 %j", async (input) => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(resolveCandidateArtifact(input)).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

it("首次解析不能用旧 SHA1 摘要代替强身份校验", async () => {
	const fetch = vi.fn().mockResolvedValue(
		Response.json({
			name: "candidate",
			version: "1.0.0",
			dist: {
				tarball: "https://registry.npmjs.org/candidate/-/candidate-1.0.0.tgz",
				shasum: hash(artifact, "sha1"),
			},
		}),
	);
	vi.stubGlobal("fetch", fetch);
	await expect(
		resolveCandidateArtifact({
			kind: "NPM",
			packageName: "candidate",
			version: "1.0.0",
		}),
	).rejects.toThrow("CANDIDATE_ACQUISITION_REJECTED");
	expect(fetch).toHaveBeenCalledOnce();
});

it.runIf(process.env.CHOICEMIND_RUN_PUBLIC_ACQUISITION === "1")(
	"真实 PyPI 解析身份无需手工输入哈希",
	async () => {
		const result = await resolveCandidateArtifact({
			kind: "PYPI",
			packageName: "six",
			version: "1.17.0",
			filename: "six-1.17.0-py2.py3-none-any.whl",
		});
		expect(result.receipt.artifactSha256).toBe(
			"4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274",
		);
		expect(result.artifact.length).toBe(11050);
		expect(result.receipt.identityOrigin).toBe("RESOLVED");
	},
	100_000,
);

it.each([
	"https://evil.test/archive",
	`https://codeload.github.com/other/candidate/legacy.tar.gz/${"a".repeat(40)}`,
	"https://codeload.github.com/example/candidate/legacy.tar.gz/main",
])("拒绝 GitHub 越界重定向 %s", async (location) => {
	const fetch = vi
		.fn()
		.mockResolvedValue(
			new Response(null, { status: 302, headers: { location } }),
		);
	vi.stubGlobal("fetch", fetch);
	await expect(acquireCandidateArtifact(sources.GITHUB)).rejects.toThrow(
		"CANDIDATE_ACQUISITION_REJECTED",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("PyPI 同哈希多个条目不能随意选一个", async () => {
	const value = {
		info: { name: "candidate", version: "1.0" },
		urls: [1, 2].map(() => ({
			url: "https://files.pythonhosted.org/packages/a.whl",
			digests: { sha256: hash(artifact) },
		})),
	};
	const fetch = vi.fn().mockResolvedValue(Response.json(value));
	vi.stubGlobal("fetch", fetch);
	await expect(acquireCandidateArtifact(sources.PYPI)).rejects.toThrow(
		"CANDIDATE_ACQUISITION_REJECTED",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("旧 npm shasum 仍必须同时满足强 SHA256 身份", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({
				name: "@example/candidate",
				version: "1.0.0",
				dist: {
					tarball:
						"https://registry.npmjs.org/@example/candidate/-/candidate-1.0.0.tgz",
					shasum: hash(artifact, "sha1"),
				},
			}),
		)
		.mockResolvedValueOnce(new Response(artifact));
	vi.stubGlobal("fetch", fetch);
	expect((await acquireCandidateArtifact(sources.NPM)).artifact).toEqual(
		artifact,
	);
});

it.each(["GITHUB", "NPM", "PYPI"] as const)(
	"%s 精确获取只返回原字节与未审查回执",
	async (kind) => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				kind === "GITHUB"
					? new Response(null, {
							status: 302,
							headers: {
								location: `https://codeload.github.com/example/candidate/legacy.tar.gz/${"a".repeat(40)}`,
							},
						})
					: Response.json(metadata(kind)),
			)
			.mockResolvedValueOnce(new Response(artifact));
		vi.stubGlobal("fetch", fetch);
		const result = await acquireCandidateArtifact(sources[kind]);
		expect(result.artifact).toEqual(artifact);
		expect(result.receipt).toMatchObject({
			source: sources[kind],
			artifactSha256: hash(artifact),
			artifactBytes: artifact.length,
			reviewStatus: "NOT_RUN",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]?.[1].headers.accept).toBe(
			kind === "GITHUB"
				? "application/vnd.github+json"
				: "application/octet-stream",
		);
		for (const [, options] of fetch.mock.calls) {
			expect(options).toMatchObject({
				method: "GET",
				redirect: "manual",
				credentials: "omit",
			});
			expect(Object.keys(options.headers).sort()).toEqual([
				"accept",
				"user-agent",
			]);
		}
	},
);

it.each([
	["NPM", "http://127.0.0.1/internal"],
	["NPM", "https://registry.npmjs.org/other/-/other-1.0.0.tgz"],
	[
		"NPM",
		"https://secret@registry.npmjs.org/@example/candidate/-/candidate-1.0.0.tgz",
	],
	["PYPI", "https://files.pythonhosted.org.evil.test/packages/a.whl"],
	["PYPI", "https://files.pythonhosted.org/packages/a.whl?token=secret"],
] as const)("拒绝 %s 元数据越界地址", async (kind, url) => {
	const fetch = vi.fn().mockResolvedValue(Response.json(metadata(kind, url)));
	vi.stubGlobal("fetch", fetch);
	await expect(acquireCandidateArtifact(sources[kind])).rejects.toThrow(
		"CANDIDATE_ACQUISITION_REJECTED",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
	"wrong-hash",
	"wrong-version",
	"redirect",
	"json",
	"metadata-limit",
	"artifact-limit",
	"integrity",
])("%s 失败关闭且不泄漏响应", async (mode) => {
	const value = metadata("NPM") as {
		name: string;
		version: string;
		dist: { tarball: string; integrity: string };
	};
	if (mode === "wrong-version") value.version = "2.0.0";
	if (mode === "integrity")
		value.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
	let response = Response.json(value);
	if (mode === "json") response = new Response("secret response not JSON");
	if (mode === "metadata-limit")
		response = new Response(Buffer.alloc(4 * 1024 * 1024 + 1));
	let download = new Response(mode === "wrong-hash" ? "changed" : artifact);
	if (mode === "redirect")
		download = new Response(null, {
			status: 302,
			headers: { location: "http://localhost/secret" },
		});
	if (mode === "artifact-limit") {
		let count = 0;
		download = new Response(
			new ReadableStream({
				pull(controller) {
					if (count++ < 65) controller.enqueue(new Uint8Array(1024 * 1024));
					else controller.close();
				},
			}),
		);
	}
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(response)
		.mockResolvedValueOnce(download);
	vi.stubGlobal("fetch", fetch);
	await expect(acquireCandidateArtifact(sources.NPM)).rejects.toThrow(
		/^CANDIDATE_ACQUISITION_REJECTED$/,
	);
});

it("未固定身份和预先取消均不请求网络", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		acquireCandidateArtifact({ ...sources.GITHUB, commitSha: "main" }),
	).rejects.toThrow();
	await expect(
		acquireCandidateArtifact(sources.NPM, AbortSignal.abort()),
	).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

it("等待响应头超出空闲期限时取消请求", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(() => new Promise<Response>(() => {}));
	vi.stubGlobal("fetch", fetch);
	const result = expect(acquireCandidateArtifact(sources.NPM)).rejects.toThrow(
		"CANDIDATE_ACQUISITION_IDLE",
	);
	await vi.advanceTimersByTimeAsync(15_001);
	await result;
	expect(
		(fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal
			?.aborted,
	).toBe(true);
});

it("响应体停滞时取消流并清除计时器", async () => {
	vi.useFakeTimers();
	const cancel = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
	);
	const result = expect(acquireCandidateArtifact(sources.NPM)).rejects.toThrow(
		"CANDIDATE_ACQUISITION_IDLE",
	);
	await vi.advanceTimersByTimeAsync(15_001);
	await result;
	expect(cancel).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
