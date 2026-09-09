import { createHash } from "node:crypto";

import type { ResearchEvidenceMaterial } from "@choicemind/evidence-ingestion";
import type { PublicWebSourceDefinition } from "@choicemind/source-research";

import type { PublicSourceAdapter } from "./worker.js";

type StaticPageResult =
	| Readonly<{
			status: "EVIDENCE_MATERIAL";
			summary: string;
			material: ResearchEvidenceMaterial;
	  }>
	| Readonly<{ status: "NO_MATCH" | "DYNAMIC_REQUIRED"; summary: string }>
	| Readonly<{
			status: "FAILED";
			code: string;
			retryable: boolean;
			summary: string;
	  }>;

type PublicWebPageCollector = Readonly<{
	discover?(input: Parameters<PublicWebPageCollector["collect"]>[0]): Promise<
		| Readonly<{ status: "DISCOVERED"; url: string; links: readonly Readonly<{ href: string; text: string; next: boolean }>[] }>
		| Exclude<StaticPageResult, { status: "EVIDENCE_MATERIAL" }>
	>;
	collect(
		input: Readonly<{
			correlationId: string;
			decisionTaskId: string;
			operationId: string;
			ownerUserId: string;
			signal: AbortSignal;
			source: Readonly<{
				sourceId: string;
				sourceRole: "OFFICIAL" | "INDEPENDENT";
				title: string;
				url: string;
			}>;
			subject: Readonly<{ subjectType: "CANDIDATE"; candidateId: string }>;
			claimTargets: readonly Readonly<{ claimId: string; statement: string }>[];
		}>,
	): Promise<StaticPageResult>;
}>;

export function createStaticPublicWebSourceAdapter(
	options: Readonly<{
		definition: PublicWebSourceDefinition;
		approvedSourceUrls?: Set<string>;
		pageCollector: PublicWebPageCollector;
		dynamicPageCollector?: PublicWebPageCollector;
	}>,
): PublicSourceAdapter {
	const dynamicPageCollector = options.dynamicPageCollector;
	return {
		accessMode: "PUBLIC",
		async run(input) {
			const target = input.claim.researchTarget;
			if (target === null) {
				return {
					type: "FAILED_FINAL",
					summary: "公开来源缺少可验证的研究目标",
				};
			}
			if (target.subject.kind !== "CANDIDATE") {
				return {
					type: "FAILED_FINAL",
					summary: `${options.definition.title}的静态品牌网页只接受 CANDIDATE 研究对象`,
				};
			}

			const pageInputFor = (url: string, operation: string) => ({
				correlationId: input.claim.jobId, decisionTaskId: input.claim.decisionTaskId,
				operationId: `${input.idempotencyKey}:${operation}`, ownerUserId: input.claim.ownerUserId,
				signal: input.signal, source: { sourceId: options.definition.sourceId,
					sourceRole: options.definition.sourceRole, title: options.definition.title, url },
				subject: { subjectType: "CANDIDATE" as const, candidateId: target.subject.value },
				claimTargets: target.claimTargets
			});
			let candidates = [...options.definition.entryUrls];
			let discoveryHasMore = false;
			if (options.approvedSourceUrls !== undefined) {
				const queue = [...options.definition.entryUrls];
				const visited = new Set<string>();
				const ranked = new Map(candidates.map(url => [url, 0]));
				// ponytail: 采用确定性词项排序；需要语义排序时复用现有 Reranker。
				const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(input.claim.query.toLowerCase())]
					.filter(part => part.isWordLike).map(part => part.segment);
				while (queue.length > 0 && visited.size < 20) {
					input.signal.throwIfAborted();
					const url = queue.shift() as string;
					if (visited.has(url)) continue;
					visited.add(url);
					const collector = options.definition.renderMode === "DYNAMIC" ? dynamicPageCollector : options.pageCollector;
					if (collector?.discover === undefined) return { type: "FAILED_FINAL", summary: "SOURCE_LINK_DISCOVERY_UNSUPPORTED" };
					let found = await collector.discover(pageInputFor(url, `search-${visited.size}`));
					if (found.status === "DYNAMIC_REQUIRED" && options.definition.renderMode === "AUTO" && dynamicPageCollector?.discover !== undefined) {
						found = await dynamicPageCollector.discover(pageInputFor(url, `search-${visited.size}:dynamic`));
					}
					if (found.status !== "DISCOVERED") return {
						type: found.status === "FAILED" && found.retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL", summary: found.summary
					};
					const base = new URL(found.url);
					if (base.protocol !== "https:" || base.username || base.password || !options.definition.allowedOrigins.includes(base.origin)) return { type: "FAILED_FINAL", summary: "SOURCE_NOT_APPROVED" };
					for (const link of found.links) {
						if (link.href.startsWith("#")) continue;
						let linked: URL;
						try { linked = new URL(link.href, base); } catch { continue; }
						if (linked.protocol !== "https:" || linked.origin !== base.origin || linked.username || linked.password) continue;
						linked.hash = "";
						if (linked.href.length > 2048) continue;
						if (link.next) {
							if (!visited.has(linked.href) && !queue.includes(linked.href) && queue.length < 20) {
								options.approvedSourceUrls.add(linked.href);
								queue.push(linked.href);
							}
						} else if (ranked.size < 200 || ranked.has(linked.href)) {
							const text = `${link.text} ${linked.pathname}`.toLowerCase();
							const score = terms.filter(term => text.includes(term)).length;
							ranked.set(linked.href, Math.max(ranked.get(linked.href) ?? 0, score));
						}
					}
				}
				candidates = [...ranked].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([url]) => url);
				discoveryHasMore = queue.length > 0 || ranked.size > 20;
				for (const url of candidates) options.approvedSourceUrls.add(url);
			}
			const entryUrls = candidates.slice(0, 5);
			const items: Extract<
				Awaited<ReturnType<PublicSourceAdapter["run"]>>,
				Readonly<{ type: "EVIDENCE_BATCH" }>
			>["items"][number][] = [];
			const resultKeys = new Set<string>();
			let deepRead = 0;
			let usedDynamic = false;
			for (const [index, url] of entryUrls.entries()) {
				input.signal.throwIfAborted();
				const pageInput = {
					correlationId: input.claim.jobId,
					decisionTaskId: input.claim.decisionTaskId,
					operationId: `${input.idempotencyKey}:page-${index}`,
					ownerUserId: input.claim.ownerUserId,
					signal: input.signal,
					source: {
						sourceId: options.definition.sourceId,
						sourceRole: options.definition.sourceRole,
						title: options.definition.title,
						url,
					},
					subject: {
						subjectType: "CANDIDATE" as const,
						candidateId: target.subject.value,
					},
					claimTargets: target.claimTargets,
				};
				let page: StaticPageResult;
				if (options.definition.renderMode === "DYNAMIC") {
					if (dynamicPageCollector === undefined) {
						return {
							type: "FAILED_FINAL",
							summary: `${options.definition.title}需要动态浏览器采集；S63-3 尚未启用该能力`,
						};
					}
					page = await dynamicPageCollector.collect({
						...pageInput,
						operationId: `${pageInput.operationId}:dynamic`,
					});
				} else {
					page = await options.pageCollector.collect({
						...pageInput,
						operationId: `${pageInput.operationId}:static`,
					});
				}
				if (
					page.status === "DYNAMIC_REQUIRED" &&
					options.definition.renderMode === "AUTO" &&
					dynamicPageCollector !== undefined
				) {
					usedDynamic = true;
					page = await dynamicPageCollector.collect({
						...pageInput,
						operationId: `${pageInput.operationId}:dynamic`,
					});
				}
				if (options.definition.renderMode === "DYNAMIC") usedDynamic = true;
				deepRead += 1;
				if (page.status === "FAILED") {
					return {
						type: page.retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
						summary: page.summary,
					};
				}
				if (page.status === "DYNAMIC_REQUIRED") {
					return {
						type: "FAILED_FINAL",
						summary: `${options.definition.title}需要动态浏览器采集；S63-2 不会把静态空壳报成成功`,
					};
				}
				if (page.status === "EVIDENCE_MATERIAL") {
					const digest = createHash("sha256")
						.update(
							[
								options.definition.sourceId,
								page.material.source.sourceType === "LIVE_PLATFORM"
									? page.material.source.url
									: url,
								page.material.rawArtifact.digest,
								...page.material.claimLinks.map((link) => link.claimId).sort(),
							].join("\0"),
							"utf8",
						)
						.digest("hex")
						.slice(0, 32);
					const resultKey = `${options.definition.sourceId}:${digest}`;
					if (!resultKeys.has(resultKey)) {
						resultKeys.add(resultKey);
						items.push({
							resultKey,
							evidenceId: `evidence-public-web-${digest}`,
							summary: page.summary,
							material: page.material,
						});
					}
				}
			}

			const checkpoint = {
				searched: candidates.length,
				deepRead,
				hasMore: discoveryHasMore || candidates.length > deepRead,
			};
			await input.saveCheckpoint(checkpoint);
			if (items.length === 0) {
				const method =
					options.definition.renderMode === "DYNAMIC"
						? "动态"
						: usedDynamic
							? "静态/动态"
							: "静态";
				return {
					type: "NO_RESULT",
					summary: `${options.definition.title}完成 ${deepRead} 个页面的${method}核验，没有匹配结果`,
					costUnits: 0,
				};
			}
			return { type: "EVIDENCE_BATCH", items, costUnits: 0, checkpoint };
		},
	};
}
