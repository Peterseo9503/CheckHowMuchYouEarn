import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

export const MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MIN = Number(process.env.AUTH_LOCKOUT_MINUTES) || 15;
const LOCKOUT_MS = DEFAULT_LOCKOUT_MIN * 60_000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(":");
  if (!salt || !keyHex) return false;
  const keyBuf = Buffer.from(keyHex, "hex");
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function safeCompareString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function getOrCreateAuthRow() {
  return prisma.authConfig.upsert({
    where: { id: "master" },
    update: {},
    create: {
      id: "master",
      passwordHash: "",
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
}

export interface LockStatus {
  locked: boolean;
  retryAfterSec: number;
  failedAttempts: number;
  remainingAttempts: number;
}

/**
 * 현재 5회 오류 잠금 상태 및 실패 횟수 조회 (DB 기반)
 */
export async function getLockStatus(): Promise<LockStatus> {
  const row = await getOrCreateAuthRow();
  const now = Date.now();

  if (row.lockedUntil && row.lockedUntil.getTime() > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((row.lockedUntil.getTime() - now) / 1000),
      failedAttempts: row.failedAttempts,
      remainingAttempts: 0,
    };
  }

  // 잠금 시간이 만료되었으면 실패 횟수 초기화
  if (row.lockedUntil && row.lockedUntil.getTime() <= now) {
    await prisma.authConfig.update({
      where: { id: "master" },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    return {
      locked: false,
      retryAfterSec: 0,
      failedAttempts: 0,
      remainingAttempts: MAX_ATTEMPTS,
    };
  }

  return {
    locked: false,
    retryAfterSec: 0,
    failedAttempts: row.failedAttempts,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - row.failedAttempts),
  };
}

/**
 * 비밀번호 실패 기록 — 5회 이상 틀리면 즉시 계정 잠금 (DB 영구 기록)
 */
export async function recordFailedAttempt(): Promise<LockStatus> {
  const row = await getOrCreateAuthRow();
  const now = Date.now();

  // 이전 잠금이 이미 만료된 상태였다면 1회부터 다시 카운트
  const baseCount =
    row.lockedUntil && row.lockedUntil.getTime() <= now ? 0 : row.failedAttempts;
  const nextCount = baseCount + 1;

  if (nextCount >= MAX_ATTEMPTS) {
    const lockedUntil = new Date(now + LOCKOUT_MS);
    await prisma.authConfig.update({
      where: { id: "master" },
      data: {
        failedAttempts: nextCount,
        lockedUntil,
      },
    });
    return {
      locked: true,
      retryAfterSec: Math.ceil(LOCKOUT_MS / 1000),
      failedAttempts: nextCount,
      remainingAttempts: 0,
    };
  }

  await prisma.authConfig.update({
    where: { id: "master" },
    data: {
      failedAttempts: nextCount,
      lockedUntil: null,
    },
  });

  return {
    locked: false,
    retryAfterSec: 0,
    failedAttempts: nextCount,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - nextCount),
  };
}

/**
 * 로그인 성공 시 실패 횟수 및 잠금 초기화
 */
export async function clearAttempts(): Promise<void> {
  await prisma.authConfig.upsert({
    where: { id: "master" },
    update: { failedAttempts: 0, lockedUntil: null },
    create: { id: "master", passwordHash: "", failedAttempts: 0, lockedUntil: null },
  });
}

/**
 * 마스터 비밀번호 검증 (초기 비밀번호 설정 화면 없이 DB 해시 또는 .env MASTER_PASSWORD 검증)
 */
export async function verifyMasterPassword(input: string): Promise<boolean> {
  const row = await getOrCreateAuthRow();
  if (row.passwordHash) {
    return verifyPasswordHash(input, row.passwordHash);
  }
  const envPw = process.env.MASTER_PASSWORD?.trim() || "0000";
  return safeCompareString(input, envPw);
}

/**
 * 로그인된 상태에서 마스터 비밀번호 변경 시 DB 저장
 */
export async function saveMasterPassword(newPassword: string): Promise<void> {
  const passwordHash = hashPassword(newPassword);
  await prisma.authConfig.upsert({
    where: { id: "master" },
    update: { passwordHash, failedAttempts: 0, lockedUntil: null },
    create: { id: "master", passwordHash, failedAttempts: 0, lockedUntil: null },
  });
}
