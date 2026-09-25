/**
 * 登录 / 注册页面。
 * 左侧为品牌展示区（自动扫描 public/login-bg 下的视频做轮播背景，叠加青柠极光带
 * 与逐字入场标题），右侧为登录/注册表单：自定义字段校验、密码可见切换、聚光卡片，
 * 提交后调用 auth store 完成登录或注册并跳转回根路由分流。
 * 视觉统一到应用品牌色（石墨深色 + 青柠 #c7f43d），动效均为纯 CSS/轻量 JS 自实现。
 */
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { EyeIcon } from "@/components/ui/icons/common/EyeIcon";
import { EyeOffIcon } from "@/components/ui/icons/common/EyeOffIcon";
import { SpinnerIcon } from "@/components/ui/icons/common/SpinnerIcon";
import { useAuthStore } from "@/features/auth/store";
import { SESSION_EXPIRED_FLAG } from "@/lib/api/client";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea One";
/** 品牌青柠（与 globals.css --canvas-accent 一致） */
const LIME = "#c7f43d";
const LIME_SOFT = "rgba(199, 244, 61, ";

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

function VideoCarousel({ onReady }: { onReady: () => void }) {
  const [videos, setVideos] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);

  // 探测 bg-v1..v4 中实际存在的文件做轮播（编号允许断档）；探测完才起播，
  // 范围只到 4 个请求，避免拖慢首屏
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
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => probe(i + 1)));
      if (cancelled) return;
      const found = results.map((ok, i) => (ok ? `login-bg/bg-v${i + 1}` : "")).filter(Boolean);
      setVideos(found);
    })();

    return () => { cancelled = true; };
  }, []);

  const prevVideo = videos.length > 0 ? videos[(current - 1 + videos.length) % videos.length] : "";
  const currVideo = videos.length > 0 ? videos[current] : "";
  const nextVideo = videos.length > 0 ? videos[(current + 1) % videos.length] : "";

  if (videos.length === 0) {
    // 探测期间不渲染任何覆盖层：露出面板的点阵底，与右侧完全一致
    return null;
  }

  // 视频先出：遮罩、极光与文字由 LeftPanel 在视频可播放（onReady）后才渲染
  return (
    <>
      {videos.length === 1 ? (
        <video
          key={videos[0]}
          className="login-anim absolute inset-0 w-full h-full object-cover opacity-0"
          style={{ animation: "loginFadeIn 0.6s ease-out 0.1s forwards" }}
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          preload="auto"
          src={`/${videos[0]}.mp4`}
          onCanPlay={onReady}
        />
      ) : (
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
            onCanPlay={onReady}
            onEnded={() => setCurrent((c) => (c + 1) % videos.length)}
          />
        </>
      )}
      {/* 下一段预加载（隐藏不播放）：切段时数据已在缓存，避免卡顿黑屏 */}
      {videos.length > 1 && (
        <video
          key={`next-${nextVideo}`}
          className="absolute w-px h-px opacity-0 pointer-events-none"
          muted
          playsInline
          preload="auto"
          src={`/${nextVideo}.mp4`}
        />
      )}
    </>
  );
}

// ── 青柠极光带 ──

function AuroraLayer() {
  return (
    <div
      className="login-anim absolute inset-0 overflow-hidden pointer-events-none opacity-0"
      style={{ animation: "loginFadeIn 0.6s ease-out 0.1s forwards" }}
    >
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
  const [videoReady, setVideoReady] = useState(false);

  // 兜底：视频异常加载不出来时，3 秒后照常显示文字，避免左侧一直空白
  useEffect(() => {
    const t = setTimeout(() => setVideoReady(true), 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="relative hidden lg:flex w-1/2 flex-col items-center justify-center overflow-hidden"
      style={{
        backgroundColor: "#0c0c0e",
        backgroundImage: "radial-gradient(rgba(231, 231, 236, 0.05) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      {/* 先出视频，可播放后再依次出遮罩、极光与文字动画 */}
      <VideoCarousel onReady={() => setVideoReady(true)} />

      {videoReady && (
        <>
          {/* 压暗遮罩：让极光与文字更突出 */}
          <div className="login-anim absolute inset-0 bg-black/35 opacity-0" style={{ animation: "loginFadeIn 0.6s ease-out 0.1s forwards" }} />
          <AuroraLayer />

          <div className="relative z-20 text-center px-12">
            <h1 className="text-4xl font-bold text-white mb-4 tracking-tight"
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
              {i18n.t("auth.login.tagline")}
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
        </>
      )}
    </div>
  );
}

// ── 整页鼠标跟随的青柠微光晕 ──

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

  const inputClass = (hasError?: string) =>
    `login-input w-full px-4 py-3 rounded-xl text-white placeholder-zinc-500 transition-all duration-200
     ${hasError ? "login-input-error" : ""}`;

  return (
    <div
      // 垂直方向用固定 padding 定位而非 flex 居中：任何首帧与稳定态之间的
      // 内容高度差都会让居中布局整体上下回弹（顶栏对齐的页面则完全不可见），
      // 固定 padding 让标题/表单位置与内容高度彻底解耦
      className="relative w-full lg:w-1/2 flex justify-center px-8 overflow-hidden"
      style={{
        paddingTop: "max(96px, calc(50vh - 200px))",
        paddingBottom: "48px",
        backgroundColor: "#0c0c0e",
        backgroundImage: "radial-gradient(rgba(231, 231, 236, 0.05) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      <div className="relative w-full max-w-[420px]">
        <div className="lg:hidden text-center mb-8">
          <h1 className="text-2xl font-bold" style={{ color: LIME }}>{APP_NAME}</h1>
        </div>

        <div
          className="mb-8 login-anim opacity-0"
          style={{ animation: "loginFadeUp 0.7s ease-out 0.3s forwards" }}
        >
          <h2 className="text-2xl font-bold text-white mb-1">
            {isSignin ? i18n.t("auth.login.title") : i18n.t("auth.login.createAccount")}
          </h2>
          <p className="text-sm" style={{ color: "#9b9ba3" }}>
            {isSignin ? i18n.t("auth.login.subtitle", { name: APP_NAME }) : i18n.t("auth.login.createSubtitle")}
          </p>
        </div>

        <form onSubmit={onSubmit} className="ui-select-none space-y-5" noValidate>
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: "#b8b8c0" }}>{i18n.t("auth.login.username")}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={i18n.t("auth.login.usernamePlaceholder")}
              aria-invalid={!!errors.username}
              className={inputClass(errors.username)}
            />
            {errors.username && (
              <p className="mt-1.5 text-sm text-red-400">{errors.username}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: "#b8b8c0" }}>{i18n.t("auth.login.password")}</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={i18n.t("auth.login.passwordPlaceholder")}
                aria-invalid={!!errors.password}
                className={`${inputClass(errors.password)} pr-11`}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? i18n.t("auth.login.hidePassword") : i18n.t("auth.login.showPassword")}
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
                  {i18n.t("common.processing")}
                </>
              ) : isSignin ? (
                i18n.t("auth.login.signIn")
              ) : (
                i18n.t("auth.login.signUp")
              )}
            </span>
          </button>
        </form>

        <div className="mt-8 text-center">
          <p className="text-sm" style={{ color: "#9b9ba3" }}>
            {isSignin ? i18n.t("auth.login.noAccount") : i18n.t("auth.login.hasAccount")}{" "}
            <button
              onClick={onToggle}
              className="font-medium transition-colors hover:opacity-80 cursor-pointer"
              style={{ color: LIME }}
            >
              {isSignin ? i18n.t("auth.login.registerNow") : i18n.t("auth.login.loginNow")}
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

  // 全局 401 登出跳转而来：读取 client.ts 留下的标记，展示一次性「会话过期」提示
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_EXPIRED_FLAG) !== "1") return;
      sessionStorage.removeItem(SESSION_EXPIRED_FLAG);
      showGlobalMessage().error(i18n.t("error.session_expired"));
    } catch { /* sessionStorage 不可用时跳过 */ }
  }, []);

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
        // 登录/注册成功后直达 /project：cookie 已下发，无需再经「/ → proxy 重定向」
        // 二次跳转（客户端软导航 + middleware 重定向组合在部分环境下不可靠，
        // 会出现「提示登录成功却停在登录页」）；全局提示渲染在 portal，不受导航影响
        if (mode === "signin") {
          await authStore.login(username, password);
          showGlobalMessage().success(i18n.t("auth.login.welcomeBack"));
          router.replace("/project");
        } else {
          await authStore.register(username, password);
          showGlobalMessage().success(i18n.t("auth.login.accountCreated"));
          router.replace("/project");
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
