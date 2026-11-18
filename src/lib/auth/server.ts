import "server-only";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { kvGet, kvSet } from "../store/db";
import { SESSION_COOKIE, SESSION_HOURS, signSession, verifySession } from "./session";

authenticator.options = { window: 1 };

interface TotpRecord {
  active?: string;
  pending?: string;
}
interface Guard {
  fails: number;
  lockedUntil?: string;
}

const MAX_FAILS = 5;
const LOCK_MIN = 15;

export async function checkPassword(username: string, password: string): Promise<boolean> {
  const u = process.env.ADMIN_USERNAME || "admin";
  const userOk = username.length === u.length && timingSafeEqual(Buffer.from(username), Buffer.from(u));
  const hash = process.env.ADMIN_PASSWORD_HASH;
  let passOk = false;
  if (hash) passOk = await bcrypt.compare(password, hash);
  else if (process.env.ADMIN_PASSWORD) {
    const p = process.env.ADMIN_PASSWORD;
    passOk = password.length === p.length && timingSafeEqual(Buffer.from(password), Buffer.from(p));
  }
  return userOk && passOk;
}

export async function guardStatus(): Promise<{ locked: boolean; until?: string }> {
  const g = (await kvGet<Guard>("auth_guard")) ?? { fails: 0 };
  if (g.lockedUntil && new Date(g.lockedUntil) > new Date()) return { locked: true, until: g.lockedUntil };
  return { locked: false };
}

export async function registerFail() {
  const g = (await kvGet<Guard>("auth_guard")) ?? { fails: 0 };
  g.fails += 1;
  if (g.fails >= MAX_FAILS) {
    g.lockedUntil = new Date(Date.now() + LOCK_MIN * 60000).toISOString();
    g.fails = 0;
  }
  await kvSet("auth_guard", g);
}

export async function clearFails() {
  await kvSet("auth_guard", { fails: 0 });
}

/** active TOTP secret: env var wins, otherwise the one enrolled from the UI */
export async function activeTotpSecret(): Promise<string | null> {
  if (process.env.TOTP_SECRET) return process.env.TOTP_SECRET;
  return (await kvGet<TotpRecord>("totp"))?.active ?? null;
}

export async function startEnrollment(): Promise<{ secret: string; uri: string }> {
  const rec = (await kvGet<TotpRecord>("totp")) ?? {};
  const secret = rec.pending ?? authenticator.generateSecret();
  await kvSet("totp", { ...rec, pending: secret });
  return { secret, uri: authenticator.keyuri(process.env.ADMIN_USERNAME || "admin", "StepBot Nobitex", secret) };
}

export async function finishEnrollment(code: string): Promise<boolean> {
  const rec = (await kvGet<TotpRecord>("totp")) ?? {};
  if (!rec.pending || !authenticator.check(code, rec.pending)) return false;
  await kvSet("totp", { active: rec.pending });
  return true;
}

export async function verifyTotp(code: string): Promise<boolean> {
  const secret = await activeTotpSecret();
  return !!secret && /^\d{6}$/.test(code) && authenticator.check(code, secret);
}

export async function setSessionCookie(username: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await signSession(username), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<string | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}
