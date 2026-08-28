"use client";

import { useState } from "react";

export function FixtureLoginLayer({ loginSessionId }: Readonly<{ loginSessionId: string }>) {
  const [state, setState] = useState<"IDLE" | "PENDING" | "DONE" | "ERROR">("IDLE");

  async function complete() {
    setState("PENDING");
    try {
      const response = await fetch(`/api/source-login/${loginSessionId}`, { method: "POST" });
      if (!response.ok) throw new Error("登录确认失败");
      setState("DONE");
    } catch {
      setState("ERROR");
    }
  }

  return (
    <main className="source-login-layer">
      <p className="eyebrow">Controlled fixture / P1</p>
      <h1>验证独立来源登录层</h1>
      <p>
        这是受控 Fixture，不代表任何真实平台。真实来源 Adapter 会在这里打开平台官方登录页，
        由你扫码或手动完成挑战；ChoiceMind 不接收账号密码。
      </p>
      {state === "DONE" ? (
        <p className="source-login-success" role="status">登录状态已保存，可以关闭此页并返回决策会话。</p>
      ) : (
        <button className="primary-action" type="button" disabled={state === "PENDING"} onClick={() => void complete()}>
          {state === "PENDING" ? "正在确认" : "完成 Fixture 登录"}
        </button>
      )}
      {state === "ERROR" ? <p className="source-error" role="alert">登录确认失败，请原地重试。</p> : null}
    </main>
  );
}
