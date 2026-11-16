import { getLockStatus } from "@/lib/auth-server";
import LoginForm from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const lockStatus = await getLockStatus();
  return <LoginForm initialLock={lockStatus} />;
}
