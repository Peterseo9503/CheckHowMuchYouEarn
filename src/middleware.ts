import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth-token";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 정적 파일 및 Next.js 내부 리소스는 통과
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // 인증 API 자체는 항상 허용
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const isAuthenticated = await verifySessionToken(token);

  // 이미 로그인된 상태에서 /login 접근 시 메인 대시보드로 이동
  if (pathname === "/login") {
    if (isAuthenticated) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  // 미인증 상태에서 보호된 API 호출 시 401 차단 (자동매매 / 선물주문 / 동기화 / 거래조회 보호)
  if (pathname.startsWith("/api/")) {
    if (!isAuthenticated) {
      return NextResponse.json(
        { error: "인증이 만료되었거나 잠금 상태입니다. 다시 로그인해주세요." },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // 미인증 상태에서 페이지 접근 시 /login 으로 리다이렉트
  if (!isAuthenticated) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
