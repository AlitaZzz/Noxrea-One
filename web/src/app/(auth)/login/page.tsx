/**
 * 登录 / 注册页面。
 * 左侧为品牌展示区（自动扫描 public/login-bg 下的视频做轮播背景，叠加青柠极光带
 * 与逐字入场标题），右侧为登录/注册表单：自定义字段校验、密码可见切换、聚光卡片，
 * 提交后调用 auth store 完成登录或注册并跳转回根路由分流。
 * 视觉统一到应用品牌色（石墨深色 + 青柠 #c7f43d），动效均为纯 CSS/轻量 JS 自实现。
 */
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { EyeIcon } from "@/components/ui/icons/common/EyeIcon";
import { EyeOffIcon } from "@/components/ui/icons/common/EyeOffIcon";
import { SpinnerIcon } from "@/components/ui/icons/common/SpinnerIcon";
import { useAuthStore } from "@/features/auth/store";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea One";
/** 品牌青柠（与 globals.css --canvas-accent 一致） */
const LIME = "#c7f43d";
const LIME_SOFT = "rgba(199, 244, 61, ";

// ── 动效 keyframes（页面私有，避免污染全局） ──

const LOGIN_STYLES = `
@keyframes loginCharIn {
  from { opacity: 0; transform: translateY(0.5em) rotateX(35deg); filter: blur(6px); }
  to   { opacity: 1; transform: none; filter: blur(0); }
}
@keyframes loginFadeUp {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
}
@keyframes loginAuroraDrift1 {
  0%, 100% { transform: translate3d(0, 0, 0) rotate(0deg) scale(1); }
  50%      { transform: translate3d(6vw, -4vh, 0) rotate(14deg) scale(1.08); }
}
@keyframes loginAuroraDrift2 {
  0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
  50%      { transform: translate3d(-5vw, 4vh, 0) scale(1.15); }
}
@keyframes loginSheen {
  0%, 55% { transform: translateX(-130%) skewX(-12deg); }
  100%    { transform: translateX(230%) skewX(-12deg); }
}
@keyframes loginUnderlineFlow {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .login-anim, .login-anim * { animation: none !important; opacity: 1 !important; transform: none !important; filter: none !important; }
}
.login-input { background: #161619; border: 1px solid #2d2d33; }
.login-input:focus { outline: none; border-color: #c7f43d; box-shadow: 0 0 0 3px rgba(199, 244, 61, 0.12); }
.login-input-error { border-color: #ef4444 !important; }
.login-input-error:focus { border-color: #ef4444 !important; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15) !important; }
`;

// ── Types ──

type AuthMode = "signin" | "signup";

// ── 逐字入场标题 ──

function SplitText({ text, delay = 0, stagger = 55, className, style }: {
  text: string;
  delay?: number;
  stagger?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className={className} style={style} aria-label={text}>
      {text.split("").map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className="inline-block opacity-0 login-anim"
          style={{ animation: `loginCharIn 0.65s cubic-bezier(0.22, 1, 0.36, 1) ${delay + i * stagger}ms forwards` }}
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

// ── 视频轮播 ──

function VideoCarousel() {
  const [videos, setVideos] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);

  // 探测 bg-v1..v20 中实际存在的文件做轮播（编号允许断档，如 v1/v3/v4/v5）
  useEffect(() => {
    let cancelled = false;
    const probe = async (seq: number) => {
      try {
        const res = await fetch(`/login-bg/bg-v${seq}.mp4`, { method: "HEAD" });
        return res.ok;
      } catch {
        return false;
      }
    };

    (async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => probe(i + 1)));
      if (cancelled) return;
      const found = results.map((ok, i) => (ok ? `login-bg/bg-v${i + 1}` : "")).filter(Boolean);
      setVideos(found);
    })();

    return () => { cancelled = true; };
  }, []);

  const prevVideo = videos.length > 0 ? videos[(current - 1 + videos.length) % videos.length] : "";
  const currVideo = videos.length > 0 ? videos[current] : "";

  if (videos.length === 0) {
    return <div className="absolute inset-0 bg-black" />;
  }

  // 只有一个视频时无需交叉过渡，单视频循环即可（双层同 src 会触发 React 重复 key 告警）
  if (videos.length === 1) {
    return (
      <video
        key={videos[0]}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
        src={`/${videos[0]}.mp4`}
      />
    );
  }

  return (
    <>
      {/* 上一段视频（底层，循环常驻，做交叉过渡） */}
      <video
        key={`prev-${prevVideo}`}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
        src={`/${prevVideo}.mp4`}
      />
      {/* 当前视频（顶层，播完即切下一段） */}
      <video
        key={`curr-${currVideo}`}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        muted
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
        src={`/${currVideo}.mp4`}
        onEnded={() => setCurrent((c) => (c + 1) % videos.length)}
      />
    </>
  );
}

// ── 青柠极光带 ──

function AuroraLayer() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="login-anim absolute rounded-full"
        style={{
          width: "70vw", height: "45vh", top: "16%", left: "-18%",
          background: `radial-gradient(closest-side, ${LIME_SOFT}0.26), transparent 70%)`,
          filter: "blur(70px)", mixBlendMode: "screen",
          animation: "loginAuroraDrift1 16s ease-in-out infinite",
        }}
      />
      <div
        className="login-anim absolute rounded-full"
        style={{
          width: "55vw", height: "35vh", bottom: "6%", right: "-12%",
          background: `radial-gradient(closest-side, ${LIME_SOFT}0.14), transparent 70%)`,
          filter: "blur(90px)", mixBlendMode: "screen",
          animation: "loginAuroraDrift2 20s ease-in-out infinite",
        }}
      />
    </div>
  );
}

// ── 左面板 ──

function LeftPanel() {
  return (
    <div className="relative hidden lg:flex w-1/2 bg-black flex-col items-center justify-center overflow-hidden">
      <style>{LOGIN_STYLES}</style>

      {/* 视频背景 */}
      <VideoCarousel />

      {/* 压暗遮罩：让极光与文字更突出 */}
      <div className="absolute inset-0 bg-black/35" />

      <AuroraLayer />

      <div className="relative z-20 text-center px-12">
        <h1 className="text-4xl font-bold text-white mb-4 tracking-tight login-anim"
          style={{ textShadow: `0 0 24px ${LIME_SOFT}0.35)`, perspective: 600 }}>
          <SplitText text={APP_NAME} />
        </h1>
        <p
          className="login-anim relative inline-block text-xl font-semibold leading-relaxed opacity-0"
          style={{
            background: `linear-gradient(90deg, rgba(231,231,236,0.9), ${LIME}, #d8f77e)`,
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            color: "transparent",
            filter: `drop-shadow(0 0 14px ${LIME_SOFT}0.25))`,
            animation: "loginFadeUp 0.7s ease-out 0.75s forwards",
          }}
        >
          从灵感碎片，到完整世界
          <span
            className="absolute -bottom-2 left-1/2 -translate-x-1/2 h-px w-3/4 login-anim"
            style={{
              background: `linear-gradient(90deg, transparent, ${LIME}, transparent)`,
              backgroundSize: "200% 100%",
              animation: "loginUnderlineFlow 3.5s linear infinite",
            }}
          />
        </p>
      </div>
    </div>
  );
}

// ── 右面板 ──

function RightPanel({
  mode,
  onToggle,
  loading,
  onSubmit,
  username,
  setUsername,
  password,
  setPassword,
  errors,
}: {
  mode: AuthMode;
  onToggle: () => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  errors: { username?: string; password?: string };
}) {
  const isSignin = mode === "signin";
  const [showPw, setShowPw] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ x: string; y: string } | null>(null);

  // 聚光效果作用于整个右半屏背景
  const handlePanelMove = useCallback((e: React.MouseEvent) => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSpot({ x: `${e.clientX - r.left}px`, y: `${e.clientY - r.top}px` });
  }, []);

  const inputClass = (hasError?: string) =>
    `login-input w-full px-4 py-3 rounded-xl text-white placeholder-zinc-500 transition-all duration-200
     ${hasError ? "login-input-error" : ""}`;

  return (
    <div
      ref={panelRef}
      onMouseMove={handlePanelMove}
      className="relative w-full lg:w-1/2 flex items-center justify-center p-8 overflow-hidden"
      style={{
        backgroundColor: "#0c0c0e",
        backgroundImage: "radial-gradient(rgba(231, 231, 236, 0.05) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      <style>{LOGIN_STYLES}</style>

      {/* 整屏鼠标跟随的青柠微光晕 */}
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-300"
        style={{
          background: spot
            ? `radial-gradient(420px circle at ${spot.x} ${spot.y}, ${LIME_SOFT}0.08), transparent 65%)`
            : "none",
          opacity: spot ? 1 : 0,
        }}
      />

      <div className="relative w-full max-w-[420px]">
        <div className="lg:hidden text-center mb-8">
          <h1 className="text-2xl font-bold" style={{ color: LIME }}>{APP_NAME}</h1>
        </div>

        <div className="mb-8 login-anim" style={{ animation: "loginFadeUp 0.6s ease-out 0.15s backwards" }}>
          <h2 className="text-2xl font-bold text-white mb-1">
            {isSignin ? "登录" : "创建账号"}
          </h2>
          <p className="text-sm" style={{ color: "#9b9ba3" }}>
            {isSignin ? `欢迎回到 ${APP_NAME}` : "开启你的创作之旅"}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: "#b8b8c0" }}>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              aria-invalid={!!errors.username}
              className={inputClass(errors.username)}
            />
            {errors.username && (
              <p className="mt-1.5 text-sm text-red-400">{errors.username}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: "#b8b8c0" }}>密码</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                aria-invalid={!!errors.password}
                className={`${inputClass(errors.password)} pr-11`}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "隐藏密码" : "显示密码"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              >
                {showPw ? (
                  <EyeIcon className="w-5 h-5" />
                ) : (
                  <EyeOffIcon className="w-5 h-5" />
                )}
              </button>
            </div>
            {errors.password && (
              <p className="mt-1.5 text-sm text-red-400">{errors.password}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="login-anim relative overflow-hidden w-full py-3 rounded-xl font-semibold text-sm transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            style={{
              backgroundColor: LIME,
              color: "#0c0c0e",
              boxShadow: `0 8px 24px ${LIME_SOFT}0.18)`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = `0 8px 32px ${LIME_SOFT}0.32)`; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = `0 8px 24px ${LIME_SOFT}0.18)`; }}
          >
            {/* 斜向光泽周期性扫过 */}
            <span
              className="login-anim absolute inset-0 pointer-events-none"
              style={{
                background: "linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.35) 50%, transparent 65%)",
                animation: "loginSheen 3.8s ease-in-out infinite",
              }}
            />
            <span className="relative flex items-center justify-center gap-2">
              {loading ? (
                <>
                  <SpinnerIcon className="animate-spin h-4 w-4" />
                  处理中...
                </>
              ) : isSignin ? (
                "登录"
              ) : (
                "注册"
              )}
            </span>
          </button>
        </form>

        <div className="mt-8 text-center">
          <p className="text-sm" style={{ color: "#9b9ba3" }}>
            {isSignin ? "还没有账号？" : "已有账号？"}{" "}
            <button
              onClick={onToggle}
              className="font-medium transition-colors hover:opacity-80 cursor-pointer"
              style={{ color: LIME }}
            >
              {isSignin ? "立即注册" : "立即登录"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main ──

export default function LoginPage() {
  const router = useRouter();
  const authStore = useAuthStore();

  const [mode, setMode] = useState<AuthMode>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // 自定义校验，替代浏览器原生「请填写此字段」气泡
      const nextErrors: { username?: string; password?: string } = {};
      if (!username.trim()) {
        nextErrors.username = i18n.t("error.auth.username_required");
      } else if (mode === "signup" && (username.trim().length < 3 || username.trim().length > 50)) {
        nextErrors.username = i18n.t("error.auth.username_length");
      }
      if (!password) {
        nextErrors.password = i18n.t("error.auth.password_required");
      } else if (mode === "signup" && password.length < 6) {
        nextErrors.password = i18n.t("error.auth.password_length");
      }
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }
      setErrors({});

      setLoading(true);

      try {
        if (mode === "signin") {
          await authStore.login(username, password);
          showGlobalMessage().success(i18n.t("auth.login.welcomeBack"));
          setTimeout(() => router.push("/"), 600);
        } else {
          await authStore.register(username, password);
          showGlobalMessage().success(i18n.t("auth.login.accountCreated"));
          setTimeout(() => router.push("/"), 600);
        }
      } catch (err: unknown) {
        showGlobalMessage().error((err as Error).message || i18n.t("error.unknown"));
      } finally {
        setLoading(false);
      }
    },
    [mode, username, password, router, authStore]
  );

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === "signin" ? "signup" : "signin"));
    setUsername("");
    setPassword("");
    setErrors({});
  }, []);

  // 输入时实时清除对应字段的错误
  const handleUsernameChange = useCallback((v: string) => {
    setUsername(v);
    setErrors((prev) => (prev.username ? { ...prev, username: undefined } : prev));
  }, []);

  const handlePasswordChange = useCallback((v: string) => {
    setPassword(v);
    setErrors((prev) => (prev.password ? { ...prev, password: undefined } : prev));
  }, []);

  return (
    <div className="flex h-screen w-screen bg-[#0c0c0e] overflow-hidden">
      <LeftPanel />
      <RightPanel
        mode={mode}
        onToggle={toggleMode}
        loading={loading}
        onSubmit={handleSubmit}
        username={username}
        setUsername={handleUsernameChange}
        password={password}
        setPassword={handlePasswordChange}
        errors={errors}
      />
    </div>
  );
}
