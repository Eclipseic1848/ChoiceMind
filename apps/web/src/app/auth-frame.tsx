import type { ReactNode } from "react";

export function AuthFrame({
  children,
  routeLabel,
}: Readonly<{ children: ReactNode; routeLabel: string }>) {
  return (
    <main className="auth-shell">
      <section className="auth-thesis" aria-labelledby="auth-thesis-title">
        <p className="wordmark">ChoiceMind / 星枢智购</p>
        <div>
          <h1 id="auth-thesis-title">让每个选择都有来路。</h1>
          <p className="auth-thesis-copy">
            从真实需求出发，沿着证据、比较和风险，一步步抵达可以复核的结论。
          </p>
        </div>
        <p className="route-line">{routeLabel}</p>
      </section>
      <section className="auth-main">{children}</section>
    </main>
  );
}
