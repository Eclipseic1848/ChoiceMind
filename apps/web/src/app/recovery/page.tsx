import { AuthFrame } from "../auth-frame";
import { RecoveryForm } from "./recovery-form";

export default function RecoveryPage() {
  return <AuthFrame routeLabel="离线恢复 / 仅限本机"><RecoveryForm /></AuthFrame>;
}
