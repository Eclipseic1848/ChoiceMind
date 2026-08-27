import { AuthFrame } from "../auth-frame";
import { CredentialForm } from "../credential-form";

export default async function RegisterPage({ searchParams }: PageProps<"/register">) {
  const params = await searchParams;
  const code = typeof params.code === "string" ? params.code : undefined;

  return (
    <AuthFrame routeLabel="01 / 接受邀请  ·  02 / 开始决策">
      <CredentialForm {...(code === undefined ? {} : { invitationCode: code })} mode="register" />
    </AuthFrame>
  );
}
