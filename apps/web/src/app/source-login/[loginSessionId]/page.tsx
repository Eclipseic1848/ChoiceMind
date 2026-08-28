import type { Metadata } from "next";

import { FixtureLoginLayer } from "./fixture-login-layer";

export const metadata: Metadata = { title: "来源登录 | ChoiceMind" };

export default async function SourceLoginPage({ params }: Readonly<{ params: Promise<{ loginSessionId: string }> }>) {
  const { loginSessionId } = await params;
  return <FixtureLoginLayer loginSessionId={loginSessionId} />;
}
