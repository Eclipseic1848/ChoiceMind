import { AuditAdmin } from "../admin-pages";
import { ManagementFrame } from "../../management-frame";

export default function AuditPage() {
  return <ManagementFrame eyebrow="Identity / Audit" requiredRole="SUPERADMIN" title="安全审计"><AuditAdmin /></ManagementFrame>;
}
