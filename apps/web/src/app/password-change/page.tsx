import { AuthFrame } from "../auth-frame";
import { TemporaryPasswordForm } from "../restricted-account";

export default function PasswordChangePage() {
  return (
    <AuthFrame routeLabel="01 / 更新凭据  ·  02 / 决策工作台">
      <TemporaryPasswordForm />
    </AuthFrame>
  );
}
