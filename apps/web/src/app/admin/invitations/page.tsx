import { InvitationsAdmin } from "../admin-pages";
import { ManagementFrame } from "../../management-frame";

export default function InvitationsPage() {
  return <ManagementFrame eyebrow="Identity / Invitations" requiredRole="ADMIN" title="邀请管理"><InvitationsAdmin /></ManagementFrame>;
}
