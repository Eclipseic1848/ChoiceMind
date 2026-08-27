import { AccountsAdmin } from "../admin-pages";
import { ManagementFrame } from "../../management-frame";

export default function AccountsPage() {
  return <ManagementFrame eyebrow="Identity / Accounts" requiredRole="ADMIN" title="账号账册"><AccountsAdmin /></ManagementFrame>;
}
