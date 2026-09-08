import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverPypiWheelCandidates } from "./candidate-pypi-index.js";

afterEach(() => vi.unstubAllGlobals());
const file = (version: string, tag: string, extra = {}) => ({
	filename: `candidate-${version}-${tag}.whl`,
	packagetype: "bdist_wheel",
	digests: { sha256: "a".repeat(64) },
	yanked: false,
	requires_python: ">=3.10",
	...extra,
});
function index() {
	return {
		info: { name: "candidate" },
		releases: {
			"1.0": [
				file("1.0", "py3-none-any"),
				file("1.0", "cp313-cp313-manylinux_2_17_x86_64"),
				file("1.0", "cp313-cp313-win_amd64"),
			],
			"2.0": [file("2.0", "py3-none-any", { requires_python: ">=99" })],
			"3.0": [file("3.0", "py3-none-any", { yanked: true })],
			"4.0rc1": [file("4.0rc1", "py3-none-any")],
		},
	};
}

it("非法包名不接触网络", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		discoverPypiWheelCandidates({ packageName: "../secret", specifier: "" }),
	).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"固定目标平台索引选择",
	() => {
		it.each([
			"normal",
			"yanked-pin",
			"prerelease",
			"identity",
			"digest",
			"specifier",
			"empty",
		])(
			"%s",
			async (mode) => {
				const data = index();
				if (mode === "identity") data.info.name = "other";
				const nativeWheel = data.releases["1.0"][1];
				if (mode === "digest" && nativeWheel)
					nativeWheel.digests.sha256 = "bad";
				const fetch = vi.fn().mockResolvedValue(Response.json(data));
				vi.stubGlobal("fetch", fetch);
				const specifier =
					mode === "yanked-pin"
						? "==3.0"
						: mode === "prerelease"
							? ">=4.0rc1"
							: mode === "specifier"
								? "--index-url=evil"
								: mode === "empty"
									? ">=99"
									: ">=1";
				const operation = discoverPypiWheelCandidates({
					packageName: "candidate",
					specifier,
				});
				if (["identity", "digest", "specifier"].includes(mode)) {
					await expect(operation).rejects.toThrow(
						"CANDIDATE_INDEX_SELECTION_FAILED",
					);
					return;
				}
				const result = await operation;
				expect(result.reviewStatus).toBe("NOT_RUN");
				expect(result.pythonVersion).toBe("3.13.14");
				expect(result.platform).toBe("linux");
				expect(result.candidates).toHaveLength(mode === "empty" ? 0 : 1);
				if (mode === "normal")
					expect(result.candidates[0]?.filename).toBe(
						"candidate-1.0-cp313-cp313-manylinux_2_17_x86_64.whl",
					);
				if (mode === "yanked-pin")
					expect(result.candidates[0]?.source).toMatchObject({
						version: "3.0",
					});
				if (mode === "prerelease")
					expect(result.candidates[0]?.source).toMatchObject({
						version: "4.0rc1",
					});
				expect(fetch).toHaveBeenCalledOnce();
				expect(fetch.mock.calls[0]?.[0]).toBe(
					"https://pypi.org/pypi/candidate/json",
				);
			},
			30_000,
		);
	},
);

it.runIf(
	process.env.CHOICEMIND_RUN_PUBLIC_ACQUISITION === "1" &&
		process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1",
)(
	"真实 PyPI 索引筛出已知 six wheel，不下载制品",
	async () => {
		const result = await discoverPypiWheelCandidates({
			packageName: "six",
			specifier: "==1.17.0",
		});
		expect(result.candidates).toEqual([
			{
				filename: "six-1.17.0-py2.py3-none-any.whl",
				source: {
					kind: "PYPI",
					packageName: "six",
					version: "1.17.0",
					artifactSha256:
						"4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274",
				},
			},
		]);
	},
	60_000,
);
