import { AuthFrame } from "../auth-frame";
import { CredentialForm } from "../credential-form";

export default function LoginPage() {
  return (
    <AuthFrame routeLabel="01 / 身份确认  ·  02 / 决策工作台">
      <CredentialForm mode="login" />
    </AuthFrame>
  );
}
