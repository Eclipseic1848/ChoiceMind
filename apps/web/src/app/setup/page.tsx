import { AuthFrame } from "../auth-frame";
import { CredentialForm } from "../credential-form";

export default function SetupPage() {
  return (
    <AuthFrame routeLabel="01 / 建立身份边界">
      <CredentialForm mode="setup" />
    </AuthFrame>
  );
}
