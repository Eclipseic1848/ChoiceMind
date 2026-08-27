import { ManagementFrame } from "../management-frame";
import { SecurityPanel } from "./security-panel";

export default function SecurityPage() {
  return (
    <ManagementFrame eyebrow="个人设置" title="账号安全">
      <SecurityPanel />
    </ManagementFrame>
  );
}
