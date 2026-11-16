import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, signSessionToken, verifySessionToken } from "@/lib/auth-token";
import {
  MAX_ATTEMPTS,
  clearAttempts,
  getLockStatus,
  recordFailedAttempt,
  saveMasterPassword,
  verifyMasterPassword,
} from "@/lib/auth-server";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

function setSessionCookie(res: NextResponse, token: string, remember: boolean) {
  const maxAgeSec = remember ? 30 * 86_400 : 86_400; // 30일 또는 24시간
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  });
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const [authenticated, lock] = await Promise.all([
    verifySessionToken(token),
    getLockStatus(),
  ]);
  return NextResponse.json({
    authenticated,
    ...lock,
    maxAttempts: MAX_ATTEMPTS,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action: "login" | "change" = body.action === "change" ? "change" : "login";
    const remember = Boolean(body.remember ?? true);

    // 1) 먼저 5회 이상 실패로 잠금된 상태인지 확인
    const lock = await getLockStatus();
    if (lock.locked) {
      const mins = Math.floor(lock.retryAfterSec / 60);
      const secs = lock.retryAfterSec % 60;
      const timeLabel = mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
      return NextResponse.json(
        {
          error: `비밀번호 ${MAX_ATTEMPTS}회 이상 오류로 계정이 잠겼습니다. (${timeLabel} 후 해제)`,
          ...lock,
          maxAttempts: MAX_ATTEMPTS,
        },
        { status: 429 }
      );
    }

    // 2) 비밀번호 변경 (로그인된 상태 + 현재 비밀번호 일치 필수)
    if (action === "change") {
      const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
      const isAuth = await verifySessionToken(token);
      if (!isAuth) {
        return NextResponse.json(
          { error: "로그인이 필요한 요청입니다." },
          { status: 401 }
        );
      }

      const currentPassword = String(body.currentPassword ?? "");
      const newPassword = String(body.newPassword ?? "").trim();

      if (newPassword.length < 4) {
        return NextResponse.json(
          { error: "새 비밀번호 또는 PIN은 최소 4자리 이상이어야 합니다." },
          { status: 400 }
        );
      }

      const valid = await verifyMasterPassword(currentPassword);
      if (!valid) {
        const fail = await recordFailedAttempt();
        return NextResponse.json(
          {
            error: fail.locked
              ? `현재 비밀번호를 ${MAX_ATTEMPTS}회 이상 틀려 계정이 잠겼습니다.`
              : `현재 비밀번호가 일치하지 않습니다. (실패 ${fail.failedAttempts}/${MAX_ATTEMPTS}회 · 남은 시도 ${fail.remainingAttempts}회)`,
            ...fail,
            maxAttempts: MAX_ATTEMPTS,
          },
          { status: fail.locked ? 429 : 401 }
        );
      }

      await saveMasterPassword(newPassword);
      const newToken = await signSessionToken(remember ? 30 * DAY_MS : DAY_MS);
      const res = NextResponse.json({ ok: true, mode: "change" });
      setSessionCookie(res, newToken, remember);
      return res;
    }

    // 3) 일반 로그인 (잠금 해제)
    const password = String(body.password ?? "");
    if (!password) {
      return NextResponse.json(
        { error: "마스터 비밀번호 또는 PIN을 입력해주세요." },
        { status: 400 }
      );
    }

    const valid = await verifyMasterPassword(password);
    if (!valid) {
      const fail = await recordFailedAttempt();
      const mins = Math.floor(fail.retryAfterSec / 60);
      const secs = fail.retryAfterSec % 60;
      const timeLabel = mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
      return NextResponse.json(
        {
          error: fail.locked
            ? `🚨 비밀번호를 ${MAX_ATTEMPTS}회 연속 틀려 계정이 잠겼습니다! (${timeLabel} 동안 접속 차단)`
            : `비밀번호 또는 PIN이 올바르지 않습니다. (실패 ${fail.failedAttempts}/${MAX_ATTEMPTS}회 · 남은 기회 ${fail.remainingAttempts}회)`,
          ...fail,
          maxAttempts: MAX_ATTEMPTS,
        },
        { status: fail.locked ? 429 : 401 }
      );
    }

    await clearAttempts();
    const token = await signSessionToken(remember ? 30 * DAY_MS : DAY_MS);
    const res = NextResponse.json({
      ok: true,
      mode: "login",
      failedAttempts: 0,
      remainingAttempts: MAX_ATTEMPTS,
      locked: false,
    });
    setSessionCookie(res, token, remember);
    return res;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
