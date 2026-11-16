"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LockStatus } from "@/lib/auth-server";

const MAX_ATTEMPTS = 5;

function formatRemainTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${String(s).padStart(2, "0")}초` : `${s}초`;
}

export default function LoginForm({ initialLock }: { initialLock: LockStatus }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showKeypad, setShowKeypad] = useState(true);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failedAttempts, setFailedAttempts] = useState(initialLock.failedAttempts);
  const [lockSec, setLockSec] = useState(initialLock.locked ? initialLock.retryAfterSec : 0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLocked = lockSec > 0;

  useEffect(() => {
    if (!isLocked) {
      inputRef.current?.focus();
    }
  }, [isLocked]);

  useEffect(() => {
    if (lockSec <= 0) return;
    const timer = setInterval(() => {
      setLockSec((s) => {
        if (s <= 1) {
          setFailedAttempts(0);
          setError("");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [lockSec]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (loading || isLocked) return;

    if (!password.trim()) {
      setError("마스터 비밀번호 또는 PIN을 입력해주세요.");
      inputRef.current?.focus();
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          password,
          remember,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (typeof json.failedAttempts === "number") {
          setFailedAttempts(json.failedAttempts);
        }
        if (json.locked && json.retryAfterSec) {
          setLockSec(Number(json.retryAfterSec));
        }
        setError(json.error || "인증에 실패했습니다.");
        setPassword("");
        inputRef.current?.focus();
        return;
      }

      router.replace("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message || "네트워크 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeypadDigit(digit: string) {
    if (isLocked || loading) return;
    setError("");
    setPassword((prev) => prev + digit);
    inputRef.current?.focus();
  }

  function handleKeypadBackspace() {
    if (isLocked || loading) return;
    setPassword((prev) => prev.slice(0, -1));
    inputRef.current?.focus();
  }

  function handleKeypadClear() {
    if (isLocked || loading) return;
    setPassword("");
    inputRef.current?.focus();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 py-10">
      <div
        className={`w-full max-w-md rounded-2xl border p-8 shadow-2xl backdrop-blur transition ${
          isLocked
            ? "border-rose-500/50 bg-neutral-900/90"
            : "border-neutral-800 bg-neutral-900/80"
        }`}
      >
        {/* 상단 아이콘 및 타이틀 */}
        <div className="mb-5 text-center">
          <div
            className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border text-2xl shadow-inner ${
              isLocked
                ? "border-rose-500/40 bg-rose-500/15"
                : "border-amber-500/30 bg-amber-500/10"
            }`}
          >
            {isLocked ? "🚨" : "🔒"}
          </div>
          <h1 className="text-xl font-bold text-neutral-100">
            {isLocked ? "보안 잠금 활성화됨" : "Trading Journal 잠금 해제"}
          </h1>
          <p className="mt-1.5 text-xs text-neutral-400">
            {isLocked
              ? "비밀번호 5회 이상 연속 오류로 인해 모든 접근이 일시 차단되었습니다."
              : "대시보드 및 자동매매·선물 주문 보호를 위해 PIN 또는 마스터 암호를 입력하세요."}
          </p>
        </div>

        {/* 5회 실패 잠금 게이지 바 */}
        <div className="mb-4 rounded-xl border border-neutral-800 bg-neutral-950/70 px-3.5 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="text-neutral-400">보안 인증 시도 상태 (5회 오류 시 잠금)</span>
            <span
              className={`font-mono font-bold ${
                failedAttempts >= MAX_ATTEMPTS
                  ? "text-rose-400"
                  : failedAttempts > 0
                  ? "text-amber-400"
                  : "text-emerald-400"
              }`}
            >
              실패 {Math.min(failedAttempts, MAX_ATTEMPTS)} / {MAX_ATTEMPTS}회
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {Array.from({ length: MAX_ATTEMPTS }).map((_, idx) => {
              const active = idx < failedAttempts;
              return (
                <div
                  key={idx}
                  className={`h-1.5 rounded-full transition-all ${
                    active
                      ? isLocked
                        ? "bg-rose-500"
                        : "bg-amber-500"
                      : "bg-neutral-800"
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* 5회 이상 실패 잠금 배너 */}
        {isLocked && (
          <div className="mb-4 rounded-xl border border-rose-500/50 bg-rose-950/40 p-4 text-center">
            <div className="text-xs font-bold text-rose-300">
              🔒 비밀번호 5회 이상 오류로 계정이 잠겼습니다
            </div>
            <div className="mt-1.5 font-mono text-lg font-black text-rose-400">
              남은 잠금 시간: {formatRemainTime(lockSec)}
            </div>
            <div className="mt-1 text-[11px] text-rose-300/70">
              잠금 시간이 끝날 때까지 비밀번호 입력이 차단됩니다.
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-400">
              마스터 비밀번호 / PIN
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setError("");
                  setPassword(e.target.value);
                }}
                disabled={loading || isLocked}
                placeholder={isLocked ? "잠금 상태입니다" : "PIN 또는 비밀번호 입력"}
                autoComplete="current-password"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 pr-16 text-center text-lg tracking-widest text-neutral-100 placeholder:tracking-normal placeholder:text-sm placeholder:text-neutral-600 focus:border-amber-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                disabled={isLocked}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
              >
                {showPassword ? "숨김" : "보기"}
              </button>
            </div>
          </div>

          {/* 숫자 PIN 빠른 입력 키패드 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-neutral-500">빠른 PIN 키패드</span>
              <button
                type="button"
                onClick={() => setShowKeypad((v) => !v)}
                className="text-xs text-neutral-400 hover:text-amber-400"
              >
                {showKeypad ? "키패드 접기 ▲" : "키패드 펼치기 ▼"}
              </button>
            </div>

            {showKeypad && (
              <div className="grid grid-cols-3 gap-2 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    disabled={loading || isLocked}
                    onClick={() => handleKeypadDigit(digit)}
                    className="rounded-lg border border-neutral-800 bg-neutral-900 py-2.5 text-base font-semibold text-neutral-200 transition hover:border-amber-500/50 hover:bg-neutral-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {digit}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={loading || isLocked}
                  onClick={handleKeypadClear}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/60 py-2.5 text-xs font-medium text-neutral-400 hover:bg-neutral-800 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  전체 지우기
                </button>
                <button
                  type="button"
                  disabled={loading || isLocked}
                  onClick={() => handleKeypadDigit("0")}
                  className="rounded-lg border border-neutral-800 bg-neutral-900 py-2.5 text-base font-semibold text-neutral-200 transition hover:border-amber-500/50 hover:bg-neutral-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  0
                </button>
                <button
                  type="button"
                  disabled={loading || isLocked}
                  onClick={handleKeypadBackspace}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/60 py-2.5 text-sm font-medium text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ⌫
                </button>
              </div>
            )}
          </div>

          {/* 일반 에러 메시지 */}
          {error && !isLocked && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2.5 text-center text-xs text-rose-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-1 text-xs text-neutral-400">
            <label className="flex cursor-pointer items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={remember}
                disabled={isLocked}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 accent-amber-500"
              />
              이 브라우저에서 30일간 잠금 해제 유지
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || isLocked}
            className="w-full rounded-lg bg-amber-500 py-3 text-sm font-bold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading
              ? "확인 중…"
              : isLocked
              ? `계정 잠금 중 (${formatRemainTime(lockSec)})`
              : "잠금 해제 (Enter)"}
          </button>
        </form>
      </div>
    </div>
  );
}
