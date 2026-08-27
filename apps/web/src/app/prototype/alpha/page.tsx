"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import styles from "./prototype.module.css";

// PROTOTYPE：两个 Alpha 产品壳方向，通过 ?variant=A|B 切换，不连接真实服务。
const variants = [
	{ key: "A", name: "对话工作台" },
	{ key: "B", name: "证据路线图" },
] as const;

type VariantKey = (typeof variants)[number]["key"];

const sources = [
	{ name: "Dell 官网", detail: "型号与接口已核验", tone: "done" },
	{ name: "京东", detail: "3 个匹配 Offer", tone: "done" },
	{ name: "什么值得买", detail: "正在整理价格条件", tone: "working" },
	{ name: "小红书", detail: "登录状态已失效", tone: "attention" },
] as const;

const candidates = [
	{
		name: "Dell P2725QE",
		fit: "最符合",
		price: "¥3,299",
		note: "接口完整，价格高于目标",
	},
	{
		name: "BenQ RD280U",
		fit: "备选",
		price: "¥4,199",
		note: "编程体验突出，明显超预算",
	},
	{
		name: "ASUS PA279CRV",
		fit: "排除",
		price: "¥3,499",
		note: "桌面深度下支架占用偏大",
	},
] as const;

export default function AlphaPrototypePage() {
	return (
		<Suspense
			fallback={<main className={styles.prototypeRoot}>正在打开原型…</main>}
		>
			<AlphaPrototypeContent />
		</Suspense>
	);
}

function AlphaPrototypeContent() {
	const searchParams = useSearchParams();
	const requested = searchParams.get("variant")?.toUpperCase();
	const variant: VariantKey = requested === "B" ? "B" : "A";

	return (
		<main className={styles.prototypeRoot}>
			{variant === "A" ? <ConversationWorkbench /> : <EvidenceRouteMap />}
			<PrototypeSwitcher current={variant} />
		</main>
	);
}

function ConversationWorkbench() {
	const loginDialog = useRef<HTMLDialogElement>(null);
	const messageInput = useRef<HTMLTextAreaElement>(null);
	const [researchPaused, setResearchPaused] = useState(false);
	const [showEvents, setShowEvents] = useState(false);
	const [showWhy, setShowWhy] = useState(false);
	const [fileName, setFileName] = useState<string>();

	return (
		<div className={`${styles.app} ${styles.workbench}`}>
			<header className={styles.topbar}>
				<a
					className={styles.brand}
					href="#main-conversation"
					aria-label="ChoiceMind 对话工作台首页"
				>
					<span className={styles.brandMark} aria-hidden="true">
						CM
					</span>
					<span>
						<strong>ChoiceMind</strong>
						<small>把选择做成证据</small>
					</span>
				</a>
				<div className={styles.topbarMeta}>
					<span className={styles.liveStatus}>
						<i />
						研究任务进行中
					</span>
					<span className={styles.quietButton}>陈屿</span>
				</div>
			</header>

			<div className={styles.workbenchGrid}>
				<aside className={styles.sessionRail} aria-label="对话列表">
					<button
						className={styles.newSession}
						type="button"
						onClick={() => messageInput.current?.focus()}
					>
						＋ 新决策
					</button>
					<nav aria-label="最近对话">
						<p className={styles.eyebrow}>最近</p>
						<a className={styles.activeSession} href="#main-conversation">
							<strong>27 英寸编程显示器</strong>
							<span>研究中 · 刚刚</span>
						</a>
						<a href="#archived-session">
							<strong>通勤降噪耳机</strong>
							<span>等待降价 · 昨天</span>
						</a>
						<a href="#archived-session">
							<strong>父母用平板</strong>
							<span>继续使用 · 8 月 22 日</span>
						</a>
					</nav>
					<div className={styles.memoryNote}>
						<span>记忆已启用</span>
						<p>偏好护眼、桌面整洁。重大条件仍会在本次对话中确认。</p>
					</div>
				</aside>

				<section
					className={styles.conversation}
					id="main-conversation"
					aria-labelledby="conversation-title"
				>
					<header className={styles.conversationHeader}>
						<div>
							<p className={styles.eyebrow}>决策会话 · CM-0827</p>
							<h1 id="conversation-title">27 英寸编程显示器</h1>
						</div>
						<span className={styles.iconButton} aria-hidden="true">
							•••
						</span>
					</header>

					<div className={styles.messages}>
						<article className={styles.userMessage}>
							<p>
								我主要写代码和剪视频，桌面深 65cm。预算最好在 3000
								元以内，偶尔连接 MacBook。
							</p>
						</article>

						<article className={styles.assistantMessage}>
							<span className={styles.assistantGlyph} aria-hidden="true">
								✦
							</span>
							<div>
								<p>
									需求已经足够开始研究。我会优先确认 USB-C
									供电、文字清晰度和桌面占用，再核对近期真实价格。
								</p>
								<ul className={styles.requirementStrip} aria-label="已确认需求">
									<li>27 英寸</li>
									<li>4K</li>
									<li>USB-C</li>
									<li>≤ ¥3,000 为目标价</li>
								</ul>
							</div>
						</article>

						<article
							className={styles.progressMessage}
							aria-labelledby="progress-title"
						>
							<div className={styles.progressHeading}>
								<div>
									<p className={styles.eyebrow}>后台研究</p>
									<h2 id="progress-title">正在核对价格与长期体验</h2>
								</div>
								<span>3 / 5</span>
							</div>
							<ol className={styles.stageList}>
								<li className={styles.stageDone}>
									<span>01</span>
									<div>
										<strong>需求边界</strong>
										<small>已形成 Requirement revision 2</small>
									</div>
								</li>
								<li className={styles.stageDone}>
									<span>02</span>
									<div>
										<strong>官方规格</strong>
										<small>3 款 Candidate 已确认身份</small>
									</div>
								</li>
								<li className={styles.stageActive}>
									<span>03</span>
									<div>
										<strong>价格与实际体验</strong>
										<small>4 个来源继续运行，1 个等待登录</small>
									</div>
								</li>
								<li>
									<span>04</span>
									<div>
										<strong>冲突与风险</strong>
										<small>等待前序证据</small>
									</div>
								</li>
								<li>
									<span>05</span>
									<div>
										<strong>形成 Decision</strong>
										<small>关键缺口解决后开始</small>
									</div>
								</li>
							</ol>
							<div className={styles.progressActions}>
								<button
									className={styles.secondaryButton}
									type="button"
									onClick={() => setResearchPaused((paused) => !paused)}
								>
									{researchPaused ? "继续研究" : "暂停研究"}
								</button>
								<button
									className={styles.textButton}
									type="button"
									onClick={() => setShowEvents((visible) => !visible)}
								>
									{showEvents ? "收起事件" : "查看全部事件"}
								</button>
							</div>
							{showEvents ? (
								<p className={styles.prototypeNotice} role="status">
									16:42 已核对 Dell 官方规格；16:43 开始整理京东 Offer。
								</p>
							) : null}
						</article>

						<article className={styles.assistantMessage}>
							<span className={styles.assistantGlyph} aria-hidden="true">
								✦
							</span>
							<div>
								<p>
									小红书的登录状态已经失效。其他来源仍在继续，不会丢失已经取得的证据。
								</p>
								<button
									className={styles.primaryButton}
									type="button"
									onClick={() => loginDialog.current?.showModal()}
								>
									重新登录小红书
								</button>
							</div>
						</article>
					</div>

					<form
						className={styles.composer}
						noValidate
						onSubmit={(event) => event.preventDefault()}
					>
						<label className={styles.srOnly} htmlFor="workbench-message">
							补充要求或提问
						</label>
						<textarea
							className="resize-none"
							id="workbench-message"
							ref={messageInput}
							rows={2}
							placeholder="补充要求，或问我为什么这样判断…"
							style={{ resize: "none" }}
						/>
						<div className={styles.composerActions}>
							<label className={styles.attachButton} htmlFor="prototype-file">
								＋ {fileName ?? "添加文件"}
							</label>
							<input
								className={styles.srOnly}
								id="prototype-file"
								type="file"
								onChange={(event) => setFileName(event.target.files?.[0]?.name)}
							/>
							<span>Enter 发送 · Shift + Enter 换行</span>
							<button
								className={styles.sendButton}
								type="submit"
								aria-label="发送消息"
							>
								发送
							</button>
						</div>
					</form>
				</section>

				<aside className={styles.researchRail} aria-label="研究概览">
					<section>
						<div className={styles.railHeading}>
							<p className={styles.eyebrow}>来源状态</p>
							<button
								type="button"
								onClick={() => loginDialog.current?.showModal()}
							>
								管理
							</button>
						</div>
						<ul className={styles.sourceList}>
							{sources.map((source) => (
								<li key={source.name}>
									<i data-tone={source.tone} />
									<div>
										<strong>{source.name}</strong>
										<span>{source.detail}</span>
									</div>
								</li>
							))}
						</ul>
					</section>
					<section className={styles.fileStatus}>
						<p className={styles.eyebrow}>你提供的材料</p>
						<div>
							<span aria-hidden="true">▧</span>
							<p>
								<strong>桌面尺寸.jpg</strong>
								<small>OCR 完成 · 1 条定位证据</small>
							</p>
						</div>
					</section>
					<section className={styles.earlyRead}>
						<p className={styles.eyebrow}>当前判断</p>
						<strong>更接近「满足价格再买」</strong>
						<p>
							Dell P2725QE 的适配度领先，但尚未找到满足你目标价的可行动 Offer。
						</p>
						<button
							className={styles.textButton}
							type="button"
							onClick={() => setShowWhy((visible) => !visible)}
						>
							{showWhy ? "收起说明" : "为什么还不能下结论？"}
						</button>
						{showWhy ? (
							<p className={styles.prototypeNotice} role="status">
								目标价与有效保修尚未同时满足，当前证据只支持继续等待。
							</p>
						) : null}
					</section>
				</aside>
			</div>

			<SourceLoginDialog dialogRef={loginDialog} />
		</div>
	);
}

function EvidenceRouteMap() {
	const loginDialog = useRef<HTMLDialogElement>(null);
	const [section, setSection] = useState<"brief" | "evidence" | "decision">(
		"decision",
	);

	return (
		<div className={`${styles.app} ${styles.dossier}`}>
			<header className={styles.dossierHeader}>
				<a className={styles.dossierBrand} href="#dossier-main">
					<strong>ChoiceMind</strong>
					<span>DECISION FILE / 0827</span>
				</a>
				<nav aria-label="主要导航">
					<a href="#files">决策档案</a>
					<a href="#memory">我的记忆</a>
					<a href="#sources">来源账户</a>
				</nav>
				<span className={styles.outlineButton}>陈屿 / 退出</span>
			</header>

			<div className={styles.dossierMain} id="dossier-main">
				<header className={styles.caseHeader}>
					<div className={styles.caseNumber}>
						<span>CASE</span>
						<strong>014</strong>
					</div>
					<div className={styles.caseTitle}>
						<p>办公设备 / 最后更新 16:42</p>
						<h1>
							给 65cm 深桌面选一台
							<br />
							真正适合写代码的 4K 显示器
						</h1>
					</div>
					<div className={styles.caseStatus}>
						<span>研究状态</span>
						<strong>
							<i /> 等待 1 个来源
						</strong>
						<button
							type="button"
							onClick={() => loginDialog.current?.showModal()}
						>
							处理登录
						</button>
					</div>
				</header>

				<nav className={styles.caseTabs} aria-label="决策档案章节">
					{(["brief", "evidence", "decision"] as const).map((key) => (
						<button
							key={key}
							type="button"
							aria-current={section === key ? "page" : undefined}
							onClick={() => setSection(key)}
						>
							<span>
								{key === "brief" ? "01" : key === "evidence" ? "02" : "03"}
							</span>
							{key === "brief"
								? "需求与候选"
								: key === "evidence"
									? "证据与风险"
									: "当前结论"}
						</button>
					))}
				</nav>

				{section === "brief" ? (
					<DossierBrief />
				) : section === "evidence" ? (
					<DossierEvidence onLogin={() => loginDialog.current?.showModal()} />
				) : (
					<DossierDecision />
				)}

				<section className={styles.followUp} aria-labelledby="follow-up-title">
					<div>
						<p>继续这份决策</p>
						<h2 id="follow-up-title">你可以补充新的条件，旧结论不会被覆盖。</h2>
					</div>
					<form noValidate onSubmit={(event) => event.preventDefault()}>
						<label className={styles.srOnly} htmlFor="dossier-message">
							补充问题
						</label>
						<textarea
							className="resize-none"
							id="dossier-message"
							rows={2}
							placeholder="例如：如果预算提高到 3500 元呢？"
							style={{ resize: "none" }}
						/>
						<button type="submit">继续对话</button>
					</form>
				</section>
			</div>

			<SourceLoginDialog dialogRef={loginDialog} />
		</div>
	);
}

function DossierBrief() {
	return (
		<section className={styles.dossierSection} aria-labelledby="brief-title">
			<div className={styles.sectionLead}>
				<p>01 / BRIEF</p>
				<h2 id="brief-title">先把“适合”说清楚</h2>
				<span>Requirement revision 2</span>
			</div>
			<div className={styles.briefGrid}>
				<dl className={styles.requirementLedger}>
					<div>
						<dt>必须满足</dt>
						<dd>27 英寸、4K、USB-C 单线连接、文字清晰</dd>
					</div>
					<div>
						<dt>使用环境</dt>
						<dd>65cm 深桌面；Windows 主机，偶尔连接 MacBook</dd>
					</div>
					<div>
						<dt>目标价格</dt>
						<dd>¥3,000 以内；价格尚未作为硬上限</dd>
					</div>
					<div>
						<dt>当前设备</dt>
						<dd>24 英寸 1080P，可继续使用</dd>
					</div>
				</dl>
				<div className={styles.candidateLedger}>
					{candidates.map((candidate, index) => (
						<article key={candidate.name}>
							<span>0{index + 1}</span>
							<div>
								<h3>{candidate.name}</h3>
								<p>{candidate.note}</p>
							</div>
							<strong>{candidate.price}</strong>
						</article>
					))}
				</div>
			</div>
		</section>
	);
}

function DossierEvidence({ onLogin }: Readonly<{ onLogin: () => void }>) {
	return (
		<section className={styles.dossierSection} aria-labelledby="evidence-title">
			<div className={styles.sectionLead}>
				<p>02 / EVIDENCE</p>
				<h2 id="evidence-title">每句话都能回到来源</h2>
				<span>18 条 Evidence · 2 条冲突</span>
			</div>
			<div className={styles.evidenceLedger}>
				<article>
					<span>规格 / 官方</span>
					<h3>USB-C 支持 90W 供电与菊链</h3>
					<p>Dell 官方规格页，接口章节。采集于今天 15:58。</p>
					<a href="#source">打开定位证据 ↗</a>
				</article>
				<article>
					<span>价格 / Offer</span>
					<h3>当前可核验到手价为 ¥3,299</h3>
					<p>京东自营 Offer；库存与保修已核验，有效至今天 23:59。</p>
					<a href="#source">查看 Offer 条件 ↗</a>
				</article>
				<article className={styles.conflictEvidence}>
					<span>体验 / 有冲突</span>
					<h3>文字锐度评价并不一致</h3>
					<p>两条独立评测对 macOS 缩放体验意见相反，需要按你的连接方式解释。</p>
					<a href="#source">比较两条证据 ↗</a>
				</article>
				<article className={styles.pendingEvidence}>
					<span>来源 / 等待操作</span>
					<h3>小红书登录状态已失效</h3>
					<p>其他来源仍在运行。登录后将从原位置继续，不会重做已完成步骤。</p>
					<button type="button" onClick={onLogin}>
						处理来源登录
					</button>
				</article>
			</div>
		</section>
	);
}

function DossierDecision() {
	return (
		<section className={styles.dossierSection} aria-labelledby="decision-title">
			<div className={styles.sectionLead}>
				<p>03 / DECISION</p>
				<h2 id="decision-title">结论不是终点，是行动边界</h2>
				<span>Revision 1 · 当前可行动</span>
			</div>
			<div className={styles.decisionHero}>
				<div className={styles.decisionStamp}>
					<span>BUY</span>
					<strong>IF PRICE</strong>
					<small>满足价格再买</small>
				</div>
				<div className={styles.decisionCopy}>
					<p className={styles.decisionKicker}>当前最佳 Candidate</p>
					<h3>Dell P2725QE</h3>
					<p>
						它最完整地满足接口、文字清晰度和桌面空间要求，但当前 Offer
						高于你确认的目标价，因此还不是“现在就买”。
					</p>
					<div className={styles.actionRule}>
						<span>行动条件</span>
						<strong>含税到手价 ≤ ¥3,000</strong>
						<small>同时确认自营或官方保修</small>
					</div>
				</div>
			</div>
			<div className={styles.decisionDetails}>
				<article>
					<p>为什么是它</p>
					<ul>
						<li>USB-C 90W，满足单线连接</li>
						<li>支架占用适合 65cm 深桌面</li>
						<li>官方与独立来源对核心规格一致</li>
					</ul>
				</article>
				<article>
					<p>仍需留意</p>
					<ul>
						<li>macOS 非整数缩放体验存在分歧</li>
						<li>小红书来源尚未恢复登录</li>
						<li>Offer 价格与库存具有时效</li>
					</ul>
				</article>
				<article>
					<p>其他候选</p>
					{candidates.slice(1).map((candidate) => (
						<div className={styles.disposition} key={candidate.name}>
							<strong>{candidate.name}</strong>
							<span>
								{candidate.fit} · {candidate.note}
							</span>
						</div>
					))}
				</article>
			</div>
		</section>
	);
}

function SourceLoginDialog({
	dialogRef,
}: Readonly<{ dialogRef: React.RefObject<HTMLDialogElement | null> }>) {
	return (
		<dialog
			className={styles.sourceDialog}
			ref={dialogRef}
			aria-labelledby="source-dialog-title"
		>
			<form method="dialog" className={styles.dialogFrame} noValidate>
				<header>
					<div>
						<p>来源授权</p>
						<h2 id="source-dialog-title">重新登录小红书</h2>
					</div>
					<button type="submit" aria-label="关闭登录窗口">
						关闭
					</button>
				</header>
				<div className={styles.officialWindow}>
					<div className={styles.browserBar}>
						<span />
						<span />
						<span />
						<strong>xiaohongshu.com · 官方登录页面</strong>
					</div>
					<div className={styles.loginPlaceholder}>
						<span aria-hidden="true">扫码</span>
						<h3>第三方官方页面将在这里打开</h3>
						<p>
							账号、密码、短信或扫码都直接由平台页面处理。ChoiceMind
							不会读取或保存你的原始密码。
						</p>
					</div>
				</div>
				<footer>
					<p>登录成功后的会话只供你的任务使用；失效后会再次提醒。</p>
					<button type="submit">稍后处理</button>
				</footer>
			</form>
		</dialog>
	);
}

function PrototypeSwitcher({ current }: Readonly<{ current: VariantKey }>) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	function select(next: VariantKey) {
		const params = new URLSearchParams(searchParams.toString());
		params.set("variant", next);
		router.replace(`${pathname}?${params.toString()}`);
	}

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			)
				return;
			if (event.key === "ArrowLeft" || event.key === "ArrowRight")
				select(current === "A" ? "B" : "A");
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	if (process.env.NODE_ENV === "production") return null;
	const index = variants.findIndex((item) => item.key === current);
	const currentVariant = variants[index] ?? variants[0];
	const previous =
		variants[(index - 1 + variants.length) % variants.length] ?? variants[0];
	const next = variants[(index + 1) % variants.length] ?? variants[0];

	return (
		<div
			className={styles.prototypeSwitcher}
			aria-label="原型方向切换器"
			role="toolbar"
		>
			<button
				type="button"
				onClick={() => select(previous.key)}
				aria-label={`切换到 ${previous.name}`}
			>
				←
			</button>
			<span>
				<small>PROTOTYPE</small>
				{current} — {currentVariant.name}
			</span>
			<button
				type="button"
				onClick={() => select(next.key)}
				aria-label={`切换到 ${next.name}`}
			>
				→
			</button>
		</div>
	);
}
