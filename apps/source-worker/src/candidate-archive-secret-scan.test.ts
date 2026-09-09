import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { scanCandidateArchiveSecrets } from "./candidate-archive-secret-scan.js";
import { recoverCandidateSandbox } from "./candidate-sandbox.js";

it("工具准备缺少基础镜像时停止，不能继续构建或拉取", async () => {
	const script = fileURLToPath(
		new URL(
			"../../../scripts/adapter-candidate/prepare-secrets-image.ps1",
			import.meta.url,
		),
	).replaceAll("'", "''");
	const { stdout } = await promisify(execFile)(
		"pwsh",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`
$global:scanProbeCalls=0
function docker {
 param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
 $global:scanProbeCalls++
 if ($Arguments -contains 'build' -or $Arguments -contains 'pull') { throw 'UNEXPECTED_BUILD' }
 $global:LASTEXITCODE=1
}
try { & '${script}'; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'CANDIDATE_SECRETS_BASE_IMAGE_MISSING') { throw } }
if ($global:scanProbeCalls -ne 2) { throw 'UNEXPECTED_CALL_COUNT' }
Write-Output 'MISSING_BASE_REJECTED'
`,
		],
		{ encoding: "utf8", windowsHide: true, timeout: 10_000 },
	);
	expect(stdout.trim()).toBe("MISSING_BASE_REJECTED");
});

// 宿主只生成此处固定的合成归档；未知归档只进入隔离容器。
async function fixture(kind: "TAR" | "WHEEL", mode: string) {
	const { stdout } = await promisify(execFile)(
		"python",
		[
			"-I",
			"-c",
			`
import io,zipfile,tarfile,base64,sys
data=io.BytesIO()
files={"adapter.py":b"raise RuntimeError('must never execute')\\n", ".gitleaks.toml":b"title='ignore'\\n", ".gitleaksignore":b"*", "empty":b""}
if sys.argv[2]=='secret': files['key.txt']=b"token='"+b"ghp"+b"_"+b"Ab3dE5gH7jK9mN2pQ4sT6vW8xY0zB1cD3fG5"+b"' # gitleaks:allow\\n"
if sys.argv[2]=='binary': files['binary']=b'\\x00\\xff'
if sys.argv[2]=='skip': files['document']=b'%PDF-1.7\\nhello'
if sys.argv[2]=='traversal': files['../escape']=b'hello'
if sys.argv[1]=='WHEEL':
 with zipfile.ZipFile(data,'w') as archive:
  for path,content in files.items(): archive.writestr(path,content)
else:
 with tarfile.open(fileobj=data,mode='w:gz') as archive:
  for path,content in files.items():
   info=tarfile.TarInfo(path); info.size=len(content); archive.addfile(info,io.BytesIO(content))
print(base64.b64encode(data.getvalue()).decode('ascii'))
`,
			kind,
			mode,
		],
		{ encoding: "utf8", windowsHide: true, timeout: 10_000 },
	);
	const archive = Buffer.from(stdout.trim(), "base64");
	return {
		archive,
		kind,
		sha256: createHash("sha256").update(archive).digest("hex"),
	};
}

it("启动前拒绝归档摘要变化", async () => {
	await expect(
		scanCandidateArchiveSecrets({
			archive: Buffer.from("bad"),
			sha256: "0".repeat(64),
			kind: "WHEEL",
		}),
	).rejects.toThrow("CANDIDATE_ARCHIVE_HASH_MISMATCH");
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"真实归档秘密扫描",
	() => {
		for (const kind of ["TAR", "WHEEL"] as const) {
			it(`${kind} 完整覆盖、命中、二进制、上游跳过与路径拒绝`, async () => {
				for (const [mode, status] of [
					["clean", "NO_FINDINGS"],
					["secret", "FINDINGS"],
					["binary", "NOT_RUN"],
					["skip", "NOT_RUN"],
				] as const) {
					const result = await scanCandidateArchiveSecrets(
						await fixture(kind, mode),
					);
					expect(result.summary).toMatchObject({
						status,
						scannerSha256:
							"09d435057df51b800201bc3bbe0820554b1cac3cd98162e9e02b20c8b441b5bd",
					});
					expect(JSON.stringify(result)).not.toContain(
						"Ab3dE5gH7jK9mN2pQ4sT6vW8xY0zB1cD3fG5",
					);
					expect(result.execution.reviewStatus).toBe("NOT_RUN");
				}
				await expect(
					scanCandidateArchiveSecrets(await fixture(kind, "traversal")),
				).rejects.toThrow("CANDIDATE_ARCHIVE_SECRET_SCAN_INCOMPLETE");
				expect(await recoverCandidateSandbox()).toBe("EMPTY");
			}, 90_000);
		}
	},
);
