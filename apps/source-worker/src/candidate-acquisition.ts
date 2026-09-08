import { createHash } from "node:crypto";
import { parseAdapterCandidateSource } from "@choicemind/source-research/adapter-candidate";

const IDLE_TIMEOUT = Symbol("candidate-acquisition-idle");
// 只获取精确公开制品；不调用包管理器、不解压、不留存、不执行候选。
export async function acquireCandidateArtifact(
	input: unknown,
	signal?: AbortSignal,
) {
	const source = parseAdapterCandidateSource(input);
	const deadline = AbortSignal.timeout(90_000);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const metadataSha256: string[] = [];
	try {
		let artifactUrl: string;
		let npmDigest:
			| {
					algorithm: "sha512" | "sha1";
					expected: string;
					encoding: "base64" | "hex";
			  }
			| undefined;
		if (source.kind === "GITHUB") {
			const response = await request(
				`https://api.github.com/repos/${source.repository}/tarball/${source.commitSha}`,
				combined,
			);
			try {
				if (response.status !== 302) throw new Error("INVALID");
				const url = new URL(response.headers.get("location") ?? "");
				if (
					url.origin !== "https://codeload.github.com" ||
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					url.pathname.toLowerCase() !==
						`/${source.repository}/legacy.tar.gz/${source.commitSha}`
				)
					throw new Error("INVALID");
				artifactUrl = url.href;
			} finally {
				await response.body?.cancel();
			}
		} else {
			const url =
				source.kind === "NPM"
					? `https://registry.npmjs.org/${encodeURIComponent(source.packageName)}/${encodeURIComponent(source.version)}`
					: `https://pypi.org/pypi/${encodeURIComponent(source.packageName)}/${encodeURIComponent(source.version)}/json`;
			const raw = await read(
				await request(url, combined),
				4 * 1024 * 1024,
				combined,
			);
			metadataSha256.push(hash(raw));
			const metadata: unknown = JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(raw),
			);
			if (!object(metadata)) throw new Error("INVALID");
			if (source.kind === "NPM") {
				if (
					metadata.name !== source.packageName ||
					metadata.version !== source.version ||
					!object(metadata.dist) ||
					typeof metadata.dist.tarball !== "string"
				)
					throw new Error("INVALID");
				const url = new URL(metadata.dist.tarball);
				const name = source.packageName.split("/").at(-1);
				if (
					url.origin !== "https://registry.npmjs.org" ||
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					decodeURIComponent(url.pathname) !==
						`/${source.packageName}/-/${name}-${source.version}.tgz`
				)
					throw new Error("INVALID");
				artifactUrl = url.href;
				if (
					typeof metadata.dist.integrity === "string" &&
					/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity)
				) {
					npmDigest = {
						algorithm: "sha512",
						expected: metadata.dist.integrity.slice(7),
						encoding: "base64",
					};
				} else if (
					metadata.dist.integrity === undefined &&
					typeof metadata.dist.shasum === "string" &&
					/^[a-f0-9]{40}$/.test(metadata.dist.shasum)
				) {
					npmDigest = {
						algorithm: "sha1",
						expected: metadata.dist.shasum,
						encoding: "hex",
					};
				} else throw new Error("INVALID");
			} else {
				if (
					!object(metadata.info) ||
					typeof metadata.info.name !== "string" ||
					metadata.info.name.toLowerCase().replace(/[-_.]+/g, "-") !==
						source.packageName ||
					metadata.info.version !== source.version ||
					!Array.isArray(metadata.urls)
				)
					throw new Error("INVALID");
				const matches = metadata.urls.filter(
					(item: unknown) =>
						object(item) &&
						object(item.digests) &&
						item.digests.sha256 === source.artifactSha256,
				);
				if (
					matches.length !== 1 ||
					!object(matches[0]) ||
					typeof matches[0].url !== "string"
				)
					throw new Error("INVALID");
				const url = new URL(matches[0].url);
				if (
					url.origin !== "https://files.pythonhosted.org" ||
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					!url.pathname.startsWith("/packages/")
				)
					throw new Error("INVALID");
				artifactUrl = url.href;
			}
		}
		const artifact = await read(
			await request(artifactUrl, combined),
			64 * 1024 * 1024,
			combined,
		);
		combined.throwIfAborted();
		if (artifact.length === 0 || hash(artifact) !== source.artifactSha256)
			throw new Error("INVALID");
		if (
			npmDigest &&
			createHash(npmDigest.algorithm)
				.update(artifact)
				.digest(npmDigest.encoding) !== npmDigest.expected
		)
			throw new Error("INVALID");
		return {
			artifact,
			receipt: {
				schemaVersion: "candidate-acquisition.v1",
				policyVersion: "public-pinned-artifact.v1",
				limits: {
					metadataBytes: 4 * 1024 * 1024,
					artifactBytes: 64 * 1024 * 1024,
					deadlineMs: 90_000,
					idleMs: 15_000,
				},
				source,
				metadataSha256,
				artifactSha256: hash(artifact),
				artifactBytes: artifact.length,
				acquiredAt: new Date().toISOString(),
				reviewStatus: "NOT_RUN" as const,
			},
		};
	} catch (error) {
		signal?.throwIfAborted();
		// 不暴露远端响应、重定向URL或JSON解析异常中的原文。
		throw new Error(
			deadline.aborted
				? "CANDIDATE_ACQUISITION_DEADLINE"
				: error === IDLE_TIMEOUT
					? "CANDIDATE_ACQUISITION_IDLE"
					: "CANDIDATE_ACQUISITION_REJECTED",
		);
	}
}

async function request(url: string, signal: AbortSignal) {
	signal.throwIfAborted();
	const controller = new AbortController();
	try {
		return await idle(
			fetch(url, {
				method: "GET",
				redirect: "manual",
				credentials: "omit",
				signal: AbortSignal.any([signal, controller.signal]),
				headers: {
					accept: "application/octet-stream",
					"user-agent": "ChoiceMind-Candidate-Acquisition",
				},
			}),
		);
	} catch (error) {
		controller.abort();
		throw error;
	}
}

async function read(response: Response, limit: number, signal: AbortSignal) {
	if (!response.ok || response.body === null) {
		await response.body?.cancel();
		throw new Error("INVALID");
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const chunk = await idle(reader.read());
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > limit) throw new Error("INVALID");
			chunks.push(Buffer.from(chunk.value));
		}
		return Buffer.concat(chunks);
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

async function idle<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(IDLE_TIMEOUT), 15_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hash(value: Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
