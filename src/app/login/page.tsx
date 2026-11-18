"use client";
import { useState } from "react";
import { api } from "@/components/client";

type Step = "password" | "code" | "enroll";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ step: string; qr?: string; secret?: string }>("/api/auth/login", {
        method: "POST",
        body: { username, password, code: step === "password" ? undefined : code },
      });
      if (r.step === "done") {
        window.location.href = "/";
        return;
      }
      if (r.step === "enroll") {
        setQr(r.qr ?? null);
        setSecret(r.secret ?? null);
      }
      setStep(r.step as Step);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h2 style={{ fontSize: 18 }}>
          <span className="brand-dot" /> ورود به ربات پله‌ای
        </h2>
        <form onSubmit={submit}>
          {step === "password" && (
            <>
              <div className="field">
                <label>نام کاربری</label>
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required dir="ltr" />
              </div>
              <div className="field">
                <label>رمز عبور</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required dir="ltr" />
              </div>
            </>
          )}
          {step === "enroll" && (
            <div className="muted" style={{ fontSize: 13 }}>
              احراز هویت دومرحله‌ای هنوز فعال نشده است. این کد QR را با Google Authenticator یا هر برنامه‌ی TOTP اسکن کنید و کد ۶ رقمی را وارد کنید.
              {qr && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="QR" style={{ display: "block", margin: "12px auto", borderRadius: 8, background: "#fff", padding: 6 }} />
              )}
              {secret && (
                <div className="num" style={{ display: "block", textAlign: "center", fontSize: 12, wordBreak: "break-all" }}>
                  {secret}
                </div>
              )}
            </div>
          )}
          {step !== "password" && (
            <div className="field">
              <label>کد ۶ رقمی برنامه‌ی احراز هویت</label>
              <input
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                required
                dir="ltr"
                style={{ letterSpacing: 6, textAlign: "center", fontSize: 18 }}
              />
            </div>
          )}
          {err && <div className="err">{err}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? "…" : step === "password" ? "ادامه" : "ورود"}
          </button>
        </form>
      </div>
    </div>
  );
}
