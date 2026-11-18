"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "./client";

const LINKS = [
  ["/", "داشبورد"],
  ["/orders", "سفارش‌ها"],
  ["/logs", "گزارش‌ها"],
  ["/settings", "تنظیمات"],
] as const;

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          ربات پله‌ای USDT/IRT
        </div>
        <nav className="nav">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} className={path === href ? "active" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={logout}>
          خروج
        </button>
      </header>
      {children}
    </div>
  );
}
