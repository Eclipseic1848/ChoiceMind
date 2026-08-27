"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

type CurrentAccount = Readonly<{ role: "USER" | "ADMIN" | "SUPERADMIN"; username: string }>;
type CurrentSession = Readonly<{
  access: "DELETION_PENDING" | "FULL" | "PASSWORD_CHANGE_REQUIRED";
  account: CurrentAccount;
}>;

export function IdentityGate({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const [account, setAccount] = useState<CurrentAccount>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await fetch("/api/identity/me", { cache: "no-store" });
        if (current.ok) {
          const result = (await current.json()) as CurrentSession;
          if (!active) return;
          if (result.access === "PASSWORD_CHANGE_REQUIRED") {
            router.replace("/password-change");
            return;
          }
          if (result.access === "DELETION_PENDING") {
            router.replace("/deletion-pending");
            return;
          }
          setAccount(result.account);
          return;
        }
        if (current.status !== 401) {
          if (active) setUnavailable(true);
          return;
        }
        const bootstrap = await fetch("/api/identity/bootstrap", { cache: "no-store" });
        const status = bootstrap.ok ? ((await bootstrap.json()) as { required: boolean }) : undefined;
        router.replace(status?.required === true ? "/setup" : "/login");
      } catch {
        if (active) setUnavailable(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);

  if (account === undefined && !unavailable) {
    return <p className="identity-loading">正在确认账号状态…</p>;
  }

  if (unavailable) {
    return (
      <main className="identity-loading">
        <div>
          <h1>身份服务暂时不可用</h1>
          <p>请确认本地服务仍在运行，然后刷新页面。</p>
        </div>
      </main>
    );
  }

  return (
    <>
      <header className="workspace-header">
        <p className="wordmark">ChoiceMind / 星枢智购</p>
        <p>你好，{account?.username}</p>
      </header>
      <div className="workspace-content">{children}</div>
    </>
  );
}
