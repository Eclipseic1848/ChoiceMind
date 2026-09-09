import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { inspectCandidateArchive } from "./candidate-archive.js";

it("归档传输前拒绝哈希不符", async () => {
	await expect(
		inspectCandidateArchive({
			archive: Buffer.from("bad"),
			sha256: "0".repeat(64),
			kind: "TAR",
		}),
	).rejects.toThrow("CANDIDATE_ARCHIVE_HASH_MISMATCH");
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"归档隔离纵向",
	() => {
		it("完整 10000 条目清单不被日志额度截断", async () => {
			const python = fileURLToPath(
				new URL(
					"../../../services/data-worker/.venv/Scripts/python.exe",
					import.meta.url,
				),
			);
			const { stdout: archive } = await promisify(execFile)(
				python,
				[
					"-I",
					"-c",
					"import io,zipfile,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as a:\n for i in range(10000): a.writestr(f'package/{i}.txt',b'')\nsys.stdout.buffer.write(b.getvalue())",
				],
				{ encoding: "buffer", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
			);
			const result = await inspectCandidateArchive({
				archive,
				sha256: createHash("sha256").update(archive).digest("hex"),
				kind: "WHEEL",
			});
			expect(result.manifest).toHaveProperty("entries.length", 10000);
			expect(result.execution.outputBytes).toBeGreaterThan(65536);
		}, 40_000);
		it.each(["TAR", "WHEEL"] as const)(
			"%s 的大于 64 KiB 内容仅在受监督容器解析，穿越路径拒绝",
			async (kind) => {
				const python = fileURLToPath(
					new URL(
						"../../../services/data-worker/.venv/Scripts/python.exe",
						import.meta.url,
					),
				);
				for (const path of ["package/说明.txt", "../escape"]) {
					// 仅在宿主生成已知合成归档；不读取未知上游，不向宿主解压。
					const fixtureCode =
						kind === "TAR"
							? `import io,tarfile,sys\nb=io.BytesIO()\nwith tarfile.open(fileobj=b,mode='w') as a:\n m=tarfile.TarInfo(${JSON.stringify(path)}); m.size=70000; a.addfile(m,io.BytesIO(b'x'*70000))\nsys.stdout.buffer.write(b.getvalue())`
							: `import io,zipfile,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as a: a.writestr(${JSON.stringify(path)},b'x'*70000)\nsys.stdout.buffer.write(b.getvalue())`;
					const { stdout: archive } = await promisify(execFile)(
						python,
						["-I", "-c", fixtureCode],
						{ encoding: "buffer", windowsHide: true, maxBuffer: 1024 * 1024 },
					);
					const sha256 = createHash("sha256").update(archive).digest("hex");
					const result = inspectCandidateArchive({ archive, sha256, kind });
					if (path.startsWith("..")) {
						await expect(result).rejects.toThrow("CANDIDATE_ARCHIVE_REJECTED");
					} else {
						await expect(result).resolves.toMatchObject({
							manifest: {
								archiveSha256: sha256,
								expandedBytes: 70000,
								entries: [{ path, bytes: 70000 }],
							},
							execution: {
								inputSha256: sha256,
								exitCode: 0,
								policyVersion: "local-python-sandbox.v1",
								reviewStatus: "NOT_RUN",
							},
						});
					}
				}
			},
			40_000,
		);
	},
);
