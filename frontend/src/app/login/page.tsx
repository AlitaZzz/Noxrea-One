"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, App } from "antd";
import { UserOutlined, LockOutlined } from "@ant-design/icons";
import { useAuthStore } from "@/stores/auth-store";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    useAuthStore.getState().initialize().then(() => {
      if (useAuthStore.getState().user) router.replace("/project");
    });
  }, [router]);

  const handleSubmit = async () => {
    if (!username.trim() || !password.trim()) return;
    setLoading(true);
    try {
      if (mode === "register") {
        const res = await api<{ token: { access_token: string }; user: any }>(
          "/api/auth/register",
          { method: "POST", body: JSON.stringify({ username: username.trim(), password }) }
        );
        if (res.code === 200) {
          setToken(res.data.token.access_token);
          message.success("Account created!");
          router.replace("/project");
        } else {
          message.error(res.msg || "Registration failed");
        }
      } else {
        await useAuthStore.getState().login(username.trim(), password);
        message.success("Welcome back!");
        router.replace("/project");
      }
    } catch (e: any) {
      message.error(e.message || "Failed");
    }
    setLoading(false);
  };

  const is: React.CSSProperties = { background: "var(--canvas-bg-elevated)", border: "1px solid var(--canvas-border-light)", color: "var(--canvas-text)", borderRadius: 8, height: 44, fontSize: 15 };

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: "var(--canvas-app-bg)" }} suppressHydrationWarning>
      {mounted && <div className="w-full max-w-sm p-8 rounded-2xl shadow-xl" style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }}>
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img src="/favicon.ico" alt="Noxrea" style={{ width: 48, height: 48 }} className="mb-3" />
          <h1 className="text-xl font-bold m-0" style={{ color: "var(--canvas-text)" }}>
            {mode === "login" ? "Sign In" : "Create Account"}
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--canvas-text-muted)" }}>
            {mode === "login" ? "Welcome back to Noxrea Canvas" : "Start your creative journey"}
          </p>
        </div>

        {/* Form */}
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>Username</div>
            <Input
              placeholder="Enter username"
              prefix={<UserOutlined style={{ color: "var(--canvas-text-dim)" }} />}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onPressEnter={handleSubmit}
              style={is}
              autoFocus
            />
          </div>
          <div>
            <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>Password</div>
            <Input.Password
              placeholder="Enter password"
              prefix={<LockOutlined style={{ color: "var(--canvas-text-dim)" }} />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onPressEnter={handleSubmit}
              style={is}
              iconRender={(v) => (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--canvas-text)" }}>
                  {v ? (
                    <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                  ) : (
                    <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
                  )}
                </svg>
              )}
            />
          </div>

          <Button type="primary" onClick={handleSubmit} loading={loading} block style={{ height: 44, fontSize: 15 }}>
            {mode === "login" ? "Sign In" : "Create Account"}
          </Button>
        </div>

        {/* Toggle mode */}
        <div className="text-center mt-6">
          <span className="text-sm" style={{ color: "var(--canvas-text-muted)" }}>
            {mode === "login" ? "Don't have an account?" : "Already have an account?"}
          </span>{" "}
          <button
            className="text-sm font-medium hover:underline"
            style={{ color: "#1677ff", background: "none", border: "none", cursor: "pointer" }}
            onClick={() => { setMode(mode === "login" ? "register" : "login"); setUsername(""); setPassword(""); }}
          >
            {mode === "login" ? "Register" : "Sign In"}
          </button>
        </div>
      </div>}
    </div>
  );
}
