import { AuthFrame } from "../auth-frame";
import { DeletionPendingPanel } from "../restricted-account";

export default function DeletionPendingPage() {
  return (
    <AuthFrame routeLabel="账号生命周期 / 等待删除">
      <DeletionPendingPanel />
    </AuthFrame>
  );
}
