"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

type ManagementRole = "ADMIN" | "SUPERADMIN" | "USER";
const ManagementRoleContext = createContext<ManagementRole | undefined>(
	undefined,
);
type GateState =
	| { kind: "checking" }
	| { kind: "denied" }
	| { kind: "unavailable" }
	| { kind: "allowed"; role: ManagementRole };

export function ManagementFrame({
	children,
	eyebrow,
	requiredRole = "USER",
	title,
}: Readonly<{
	children: ReactNode;
	eyebrow: string;
	requiredRole?: ManagementRole;
	title: string;
}>) {
	const router = useRouter();
	const [gate, setGate] = useState<GateState>({ kind: "checking" });

	useEffect(() => {
		let active = true;
		void fetch("/api/identity/me", { cache: "no-store" })
			.then(async (response) => {
				if (!active) return;
				if (response.status === 401) {
					router.replace("/login");
					return;
				}
				if (!response.ok) return setGate({ kind: "unavailable" });
				const result = (await response.json()) as {
					access: "DELETION_PENDING" | "FULL" | "PASSWORD_CHANGE_REQUIRED";
					principal: { role: ManagementRole };
				};
				if (result.access === "PASSWORD_CHANGE_REQUIRED") {
					router.replace("/password-change");
					return;
				}
				if (result.access === "DELETION_PENDING") {
					router.replace("/deletion-pending");
					return;
				}
				if (!roleAllows(result.principal.role, requiredRole)) {
					setGate({ kind: "denied" });
					return;
				}
				setGate({ kind: "allowed", role: result.principal.role });
			})
			.catch(() => {
				if (active) setGate({ kind: "unavailable" });
			});
		return () => {
			active = false;
		};
	}, [requiredRole, router]);

	if (gate.kind === "checking") {
		return <p className="identity-loading">正在确认管理权限…</p>;
	}
	if (gate.kind === "denied") {
		return (
			<main className="identity-loading permission-state">
				<div>
					<h1>没有管理权限</h1>
					<p>当前账号不能查看或操作这部分账号元数据。</p>
				</div>
			</main>
		);
	}
	if (gate.kind === "unavailable") {
		return (
			<main className="identity-loading permission-state">
				<div>
					<h1>管理权限暂时无法确认</h1>
					<p>请确认本地服务仍在运行，然后刷新页面。</p>
				</div>
			</main>
		);
	}

	return (
		<ManagementRoleContext.Provider value={gate.role}>
			<main className="management-layout">
				<aside className="management-nav" aria-label="账号与管理">
					<p className="wordmark">ChoiceMind / 控制台</p>
					<nav>
						<Link href="/">决策工作台</Link>
						<Link href="/security">账号安全</Link>
						{gate.role === "USER" ? null : (
							<Link href="/admin/accounts">账号账册</Link>
						)}
						{gate.role === "USER" ? null : (
							<Link href="/admin/invitations">邀请管理</Link>
						)}
						{gate.role === "SUPERADMIN" ? (
							<Link href="/admin/audit">安全审计</Link>
						) : null}
					</nav>
				</aside>
				<section className="management-main">
					<header className="management-heading">
						<p className="eyebrow">{eyebrow}</p>
						<h1>{title}</h1>
					</header>
					{children}
				</section>
			</main>
		</ManagementRoleContext.Provider>
	);
}

export function useManagementRole(): ManagementRole {
	const role = useContext(ManagementRoleContext);
	if (role === undefined) {
		throw new Error("管理页面缺少 Principal 上下文");
	}
	return role;
}

function roleAllows(actual: ManagementRole, required: ManagementRole): boolean {
	const rank: Record<ManagementRole, number> = {
		USER: 0,
		ADMIN: 1,
		SUPERADMIN: 2,
	};
	return rank[actual] >= rank[required];
}
