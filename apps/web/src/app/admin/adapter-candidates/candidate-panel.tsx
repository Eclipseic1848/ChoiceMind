"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "./candidate-panel.module.css";

const checks = {
	dependencies: "依赖与已知漏洞",
	entrypoints: "调用入口",
	network: "网络边界",
	secrets: "秘密扫描",
	basicCollection: "基本采集",
	loginExpiry: "登录失效",
	rateLimit: "平台限流",
	emptyResult: "空结果",
	failureHandling: "故障处理",
};
type Check = {
	status: "PASSED" | "FAILED" | "NOT_RUN";
	checkCount: number;
	findingCount: number;
};
type Item = {
	candidate: {
		candidateId: string;
		source: {
			kind: string;
			packageName?: string;
			repository?: string;
			version?: string;
			commitSha?: string;
			artifactSha256: string;
		};
		review: {
			reviewedAt: string;
			reportSha256: string;
			checks: Record<keyof typeof checks, Check>;
		};
	};
	lifecycle: {
		state: "AWAITING_APPROVAL" | "REVIEW_FAILED" | "ENABLED" | "DISABLED";
		reviewBindingSha256: string;
	};
};
const states = {
	AWAITING_APPROVAL: "等待首次确认",
	REVIEW_FAILED: "暂不可启用",
	ENABLED: "已启用",
	DISABLED: "已停用",
};
const statusText = { PASSED: "已通过", FAILED: "未通过", NOT_RUN: "未完成" };
const name = (item: Item) =>
	item.candidate.source.packageName ??
	item.candidate.source.repository ??
	"未知来源";
const version = (item: Item) =>
	item.candidate.source.version ??
	item.candidate.source.commitSha?.slice(0, 12) ??
	"—";

export function CandidatePanel() {
	const router = useRouter();
	const params = useSearchParams();
	const cursor = params.get("cursor") ?? "";
	const id = params.get("candidate") ?? "";
	const [page, setPage] = useState<{
		items: Item[];
		nextCursor: string | null;
	}>({ items: [], nextCursor: null });
	const [detail, setDetail] = useState<Item | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [revision, setRevision] = useState(0);
	const [confirmation, setConfirmation] = useState<"ENABLE" | "DISABLE" | null>(
		null,
	);
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const actionButton = useRef<HTMLButtonElement>(null);
	const generation = useRef(0);
	const requestKey = useRef<string | null>(null);
	const [unknown, setUnknown] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision 是用户显式刷新与提交后重新读取的触发器。
	useEffect(() => {
		const controller = new AbortController();
		const current = ++generation.current;
		setLoading(true);
		setError("");
		setConfirmation(null);
		setDetail(null);
		setPending(false);
		setUnknown(false);
		requestKey.current = null;
		void (async () => {
			try {
				const endpoint = id
					? `/${encodeURIComponent(id)}`
					: `?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
				const response = await fetch(`/api/adapter-candidates${endpoint}`, {
					cache: "no-store",
					signal: AbortSignal.any([
						controller.signal,
						AbortSignal.timeout(15_000),
					]),
				});
				if (current !== generation.current || controller.signal.aborted) return;
				if (response.status === 401) {
					setPage({ items: [], nextCursor: null });
					router.replace("/login");
					return;
				}
				if (!response.ok)
					throw new Error(
						response.status === 403
							? "当前账号没有来源工具管理权限。"
							: response.status === 404
								? "这项候选已不存在，请返回列表。"
								: "来源工具暂时无法读取，请重试。",
					);
				const data = await response.json();
				if (current !== generation.current || controller.signal.aborted) return;
				if (id) setDetail(readItem(data));
				else {
					if (
						!data ||
						!Array.isArray(data.items) ||
						data.items.length > 50 ||
						(data.nextCursor !== null &&
							(typeof data.nextCursor !== "string" ||
								!/^[1-9][0-9]{0,18}$/.test(data.nextCursor)))
					)
						throw new Error("返回内容无法确认，请重试。");
					setPage({
						items: data.items.map(readItem),
						nextCursor: data.nextCursor,
					});
				}
			} catch (cause) {
				if (!controller.signal.aborted && current === generation.current)
					setError(
						cause instanceof Error &&
							[
								"当前账号没有来源工具管理权限。",
								"这项候选已不存在，请返回列表。",
								"返回内容无法确认，请重试。",
							].includes(cause.message)
							? cause.message
							: "来源工具暂时无法读取，请重试。",
					);
			} finally {
				if (current === generation.current && !controller.signal.aborted)
					setLoading(false);
			}
		})();
		return () => {
			controller.abort();
			generation.current++;
		};
	}, [cursor, id, revision, router]);

	useEffect(() => {
		if (confirmation) cancelButton.current?.focus();
	}, [confirmation]);
	const listUrl = `/admin/adapter-candidates${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
	function closeConfirmation() {
		if (busy.current) return;
		setConfirmation(null);
		actionButton.current?.focus();
	}

	async function applyAction() {
		if (!detail || !confirmation || busy.current || unknown) return;
		busy.current = true;
		setPending(true);
		setError("");
		const current = generation.current;
		try {
			requestKey.current ??= Array.from(
				crypto.getRandomValues(new Uint8Array(16)),
				(value) => value.toString(16).padStart(2, "0"),
			).join("");
			const response = await fetch(
				`/api/adapter-candidates/${detail.candidate.candidateId}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: confirmation,
						reviewBindingSha256: detail.lifecycle.reviewBindingSha256,
						requestId: requestKey.current,
						...(confirmation === "DISABLE"
							? { reasonCode: "ADMIN_REQUEST" }
							: {}),
					}),
					signal: AbortSignal.timeout(15_000),
				},
			);
			if (current !== generation.current) return;
			if (response.status === 401 || response.status === 403) {
				setDetail(null);
				setPage({ items: [], nextCursor: null });
				setConfirmation(null);
				if (response.status === 401) router.replace("/login");
				else setError("管理权限已变化，请返回工作台。");
				return;
			}
			if (response.status === 409) {
				setUnknown(true);
				setError("报告或状态已变化。请重新读取，检查后再确认。");
				return;
			}
			if (!response.ok) throw new Error("UNCONFIRMED");
			setNotice(
				confirmation === "ENABLE"
					? "启用确认已记录。实际来源加载仍由服务端检查。"
					: "停用确认已记录。",
			);
			setConfirmation(null);
			setRevision((value) => value + 1);
		} catch {
			if (current === generation.current) {
				setUnknown(true);
				setError("操作结果尚未确认。请先重新读取当前状态，不要重复提交。");
			}
		} finally {
			busy.current = false;
			if (current === generation.current) setPending(false);
		}
	}

	const complete =
		detail &&
		Object.keys(checks).every(
			(key) =>
				detail.candidate.review.checks[key as keyof typeof checks]?.status ===
				"PASSED",
		);
	const canEnable =
		complete &&
		(detail?.lifecycle.state === "AWAITING_APPROVAL" ||
			detail?.lifecycle.state === "DISABLED");
	return (
		<div className={styles.panel}>
			<div className={styles.toolbar}>
				<p>
					{id ? (
						<Link href={listUrl}>返回来源工具</Link>
					) : (
						"查看候选工具的检查结果，决定是否允许正式使用。"
					)}
				</p>
				<button
					type="button"
					disabled={loading || pending}
					onClick={() => setRevision((value) => value + 1)}
				>
					{unknown ? "重新读取状态" : "刷新"}
				</button>
			</div>
			{notice && <p role="status">{notice}</p>}
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{loading && (
				<p role="status" className={styles.loading}>
					正在读取来源工具…
				</p>
			)}
			{!id && !loading && !error && (
				<>
					{page.items.length === 0 ? (
						<div className={styles.empty}>
							<h2>暂无候选工具</h2>
							<p>
								候选完成审查后会显示在这里。没有候选时，不需要进行启用操作。
							</p>
						</div>
					) : (
						<div className="table-scroll">
							<table>
								<caption className={styles.caption}>
									来源工具 · 本页 {page.items.length} 项，按最新报告排列
								</caption>
								<thead>
									<tr>
										<th scope="col">工具</th>
										<th scope="col">版本</th>
										<th scope="col">检查</th>
										<th scope="col">使用状态</th>
										<th scope="col">操作</th>
									</tr>
								</thead>
								<tbody>
									{page.items.map((item) => (
										<tr key={item.candidate.candidateId}>
											<th scope="row">
												{name(item)}
												<small className={styles.source}>
													{item.candidate.source.kind}
												</small>
											</th>
											<td>{version(item)}</td>
											<td>
												{
													Object.keys(checks).filter(
														(key) =>
															item.candidate.review.checks[
																key as keyof typeof checks
															].status === "PASSED",
													).length
												}{" "}
												/ 9 已通过
											</td>
											<td>{states[item.lifecycle.state]}</td>
											<td>
												<Link
													href={`${listUrl}${cursor ? "&" : "?"}candidate=${item.candidate.candidateId}`}
													aria-label={`查看 ${name(item)} 的检查结果`}
												>
													查看详情
												</Link>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<nav className={styles.toolbar} aria-label="候选分页">
						<Link href="/admin/adapter-candidates">返回最新一页</Link>
						{page.nextCursor ? (
							<Link
								href={`/admin/adapter-candidates?cursor=${page.nextCursor}`}
							>
								下一页
							</Link>
						) : (
							<span>已到末页</span>
						)}
					</nav>
				</>
			)}
			{id && detail && !loading && (
				<section aria-label="候选详情">
					<div className={styles.summary}>
						<div>
							<h2>{name(detail)}</h2>
							<p>
								{detail.candidate.source.kind} · {version(detail)} ·{" "}
								{states[detail.lifecycle.state]}
							</p>
						</div>
						<button
							ref={actionButton}
							type="button"
							disabled={
								pending ||
								unknown ||
								(!canEnable && detail.lifecycle.state !== "ENABLED")
							}
							onClick={() => {
								requestKey.current = null;
								setConfirmation(
									detail.lifecycle.state === "ENABLED" ? "DISABLE" : "ENABLE",
								);
							}}
						>
							{detail.lifecycle.state === "ENABLED" ? "停用工具" : "确认启用"}
						</button>
					</div>
					{!complete && (
						<p>
							仍有未通过或未完成的检查，暂不能启用。测试通过也不会自动启用。
						</p>
					)}
					{confirmation && (
						<section
							className={styles.confirmation}
							aria-label="启停确认"
							onKeyDown={(event) => {
								if (event.key === "Escape") closeConfirmation();
							}}
						>
							<h3>
								{confirmation === "ENABLE"
									? "允许正式使用这个工具？"
									: "停用这个工具？"}
							</h3>
							<p>
								{name(detail)} · {version(detail)}
							</p>
							<p>
								{confirmation === "ENABLE"
									? "本次确认只适用于当前制品与检查报告，不授权读取用户的 Cookie、API Key 或私人文件。"
									: "将停止后续正式加载。检查报告和历史记录会保留，不删除用户数据。"}
							</p>
							<div className="button-row">
								<button
									ref={cancelButton}
									type="button"
									disabled={pending}
									onClick={closeConfirmation}
								>
									取消
								</button>
								<button
									type="button"
									disabled={pending || unknown}
									aria-busy={pending}
									onClick={() => void applyAction()}
								>
									{pending
										? "正在记录…"
										: confirmation === "ENABLE"
											? "确认启用此版本"
											: "确认停用"}
								</button>
							</div>
						</section>
					)}
					<dl className={styles.checks}>
						{Object.entries(checks).map(([key, label]) => {
							const check =
								detail.candidate.review.checks[key as keyof typeof checks];
							return (
								<div key={key}>
									<dt>{label}</dt>
									<dd>{statusText[check?.status ?? "NOT_RUN"]}</dd>
								</div>
							);
						})}
					</dl>
					<details className={styles.technical}>
						<summary>版本与核验信息</summary>
						<dl>
							<dt>检查时间（UTC）</dt>
							<dd>{detail.candidate.review.reviewedAt}</dd>
							<dt>制品 SHA-256</dt>
							<dd>{detail.candidate.source.artifactSha256}</dd>
							<dt>报告 SHA-256</dt>
							<dd>{detail.candidate.review.reportSha256}</dd>
						</dl>
					</details>
				</section>
			)}
		</div>
	);
}

function readItem(value: unknown): Item {
	const item = value as Item | null;
	if (
		!item ||
		!/^adapter-candidate-[a-f0-9]{64}$/.test(
			item.candidate?.candidateId ?? "",
		) ||
		!Object.hasOwn(states, item.lifecycle?.state ?? "") ||
		!/^[a-f0-9]{64}$/.test(item.lifecycle?.reviewBindingSha256 ?? "") ||
		!item.candidate.source ||
		typeof item.candidate.source.kind !== "string" ||
		(["packageName", "repository", "version", "commitSha"] as const).some(
			(key) => {
				const field = item.candidate.source[key];
				return (
					field !== undefined &&
					(typeof field !== "string" || field.length === 0)
				);
			},
		) ||
		(!item.candidate.source.packageName && !item.candidate.source.repository) ||
		!/^[a-f0-9]{64}$/.test(item.candidate.source.artifactSha256 ?? "") ||
		!item.candidate.review ||
		!/^[a-f0-9]{64}$/.test(item.candidate.review.reportSha256 ?? "") ||
		typeof item.candidate.review.reviewedAt !== "string" ||
		Object.keys(checks).some(
			(key) =>
				!Object.hasOwn(
					statusText,
					item.candidate.review.checks?.[key as keyof typeof checks]?.status ??
						"",
				),
		)
	)
		throw new Error("返回内容无法确认，请重试。");
	return item;
}
