import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recoverCandidateSandbox } from "./candidate-sandbox.js";
import { scanCandidateTextSecrets } from "./candidate-secret-scan.js";

function input(value: string | Buffer) {
	const text = Buffer.from(value);
	return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

it("拒绝摘要不符、二进制和无效 UTF-8，不启动扫描器", async () => {
	await expect(
		scanCandidateTextSecrets({ ...input("hello"), sha256: "0".repeat(64) }),
	).rejects.toThrow("CANDIDATE_SECRET_TEXT_HASH_MISMATCH");
	for (const text of [Buffer.from([0]), Buffer.from([255]), Buffer.alloc(0)]) {
		await expect(scanCandidateTextSecrets(input(text))).rejects.toThrow(
			"CANDIDATE_SECRET_TEXT_INVALID",
		);
	}
});

describe.runIf(process.env.CHOICEMIND_RUN_CANDIDATE_SANDBOX === "1")(
	"真实隔离 Gitleaks",
	() => {
		it("普通文本无命中；合成令牌不能通过 allow 注释隐藏，报告不含原文", async () => {
			const clean = await scanCandidateTextSecrets(
				input("A public shopping adapter description.\n"),
			);
			expect(clean.status).toBe("NO_FINDINGS");
			const token = ["ghp", "Ab3dE5gH7jK9mN2pQ4sT6vW8xY0zB1cD3fG5"].join("_");
			const found = await scanCandidateTextSecrets(
				input(
					`${"Public adapter documentation.\n".repeat(4000)}token = '${token}' # gitleaks:allow\n`,
				),
			);
			expect(found.status).toBe("FINDINGS");
			expect(JSON.stringify(found)).not.toContain(token);
			expect(found.execution.outputBytes).toBeLessThan(16);
			expect(found.execution.reviewStatus).toBe("NOT_RUN");
			const disguised = await scanCandidateTextSecrets(
				input(`%PDF-1.7\ntoken = '${token}'\n`),
			);
			expect(disguised.status).toBe("NOT_RUN");
			expect(await recoverCandidateSandbox()).toBe("EMPTY");
		}, 40_000);
	},
);
