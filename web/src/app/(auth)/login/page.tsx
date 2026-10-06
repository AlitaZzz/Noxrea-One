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

import { SpinnerIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useAuthStore } from "@/features/auth/store";
import { SESSION_EXPIRED_FLAG } from "@/lib/api/client";
import i18n from "@/lib/i18n/config";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea One";
/** 品牌青柠：引用 globals.css 变量，避免双处漂移 */
const LIME = "var(--primary)";
/** 品牌青柠的透明度变体：由同一变量经 color-mix 派生 */
const limeAlpha = (alpha: number) =>
  `color-mix(in srgb, var(--primary) ${Math.round(alpha * 100)}%, transparent)`;

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
          background: `radial-gradient(closest-side, ${limeAlpha(0.26)}, transparent 70%)`,
          filter: "blur(70px)", mixBlendMode: "screen",
          animation: "loginAuroraDrift1 16s ease-in-out infinite",
        }}
      />
      <div
        className="login-anim absolute rounded-full"
        style={{
          width: "55vw", height: "35vh", bottom: "6%", right: "-12%",
          background: `radial-gradient(closest-side, ${limeAlpha(0.14)}, transparent 70%)`,
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
      className="relative hidden w-1/2 flex-col items-center justify-center overflow-hidden bg-background lg:flex"
      style={{
        backgroundImage: "radial-gradient(color-mix(in srgb, var(--foreground) 5%, transparent) 1px, transparent 1px)",
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
              style={{ textShadow: `0 0 24px ${limeAlpha(0.35)}`, perspective: 600 }}>
              <SplitText text={APP_NAME} />
            </h1>
            <p
              className="login-anim relative inline-block text-xl font-semibold leading-relaxed opacity-0"
              style={{
                background: `linear-gradient(90deg, color-mix(in srgb, var(--foreground) 90%, transparent), ${LIME}, var(--primary))`,
                backgroundClip: "text",
                WebkitBackgroundClip: "text",
                color: "transparent",
                filter: `drop-shadow(0 0 14px ${limeAlpha(0.25)})`,
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

  return (
    <div
      // 垂直方向用固定 padding 定位而非 flex 居中：任何首帧与稳定态之间的
      // 内容高度差都会让居中布局整体上下回弹（顶栏对齐的页面则完全不可见），
      // 固定 padding 让标题/表单位置与内容高度彻底解耦
      className="relative flex w-full justify-center overflow-hidden bg-background px-8 lg:w-1/2"
      style={{
        paddingTop: "max(96px, calc(50vh - 200px))",
        paddingBottom: "48px",
        backgroundImage: "radial-gradient(color-mix(in srgb, var(--foreground) 5%, transparent) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      <div className="relative w-full max-w-[420px]">
        <div className="lg:hidden text-center mb-8">
          <h1 className="text-2xl font-bold text-primary">{APP_NAME}</h1>
        </div>

        <Card
          className="login-anim w-full opacity-0"
          style={{ animation: "loginFadeUp 0.7s ease-out 0.3s forwards" }}
        >
          <CardHeader>
            <CardTitle className="text-xl">
              {isSignin ? i18n.t("auth.login.title") : i18n.t("auth.login.createAccount")}
            </CardTitle>
            <CardDescription>
              {isSignin ? i18n.t("auth.login.subtitle", { name: APP_NAME }) : i18n.t("auth.login.createSubtitle")}
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={onToggle}
                className="h-auto p-0 font-medium text-primary"
              >
                {isSignin ? i18n.t("auth.login.registerNow") : i18n.t("auth.login.loginNow")}
              </Button>
            </CardAction>
          </CardHeader>

          <form onSubmit={onSubmit} className="ui-select-none flex flex-col gap-6" noValidate>
            <CardContent className="space-y-5">
            <div>
            <Label htmlFor="login-username" className="mb-2 text-foreground">{i18n.t("auth.login.username")}</Label>
            <Input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={i18n.t("auth.login.usernamePlaceholder")}
              aria-invalid={errors.username ? true : undefined}
              aria-describedby={errors.username ? "login-username-error" : undefined}
            />
            {errors.username && (
              <p id="login-username-error" className="mt-1.5 text-sm text-destructive">{errors.username}</p>
            )}
            </div>

            <div>
            <Label htmlFor="login-password" className="mb-2 text-foreground">{i18n.t("auth.login.password")}</Label>
            <PasswordInput
              id="login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={i18n.t("auth.login.passwordPlaceholder")}
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? "login-password-error" : undefined}
              showLabel={i18n.t("auth.login.showPassword")}
              hideLabel={i18n.t("auth.login.hidePassword")}
            />
            {errors.password && (
              <p id="login-password-error" className="mt-1.5 text-sm text-destructive">{errors.password}</p>
            )}
            </div>
            </CardContent>

            <CardFooter className="flex-col gap-2">
              <Button
                type="submit"
                size="lg"
                block
                disabled={loading}
                className="login-anim relative overflow-hidden"
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
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}

// ── Main ──

export default function LoginPage() {
  const router = useRouter();
  const authStore = useAuthStore();
  const { message } = useAppFeedback();

  // 全局 401 登出跳转而来：读取 client.ts 留下的标记，展示一次性「会话过期」提示
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_EXPIRED_FLAG) !== "1") return;
      sessionStorage.removeItem(SESSION_EXPIRED_FLAG);
      message.error(i18n.t("error.session_expired"));
    } catch { /* sessionStorage 不可用时跳过 */ }
  }, [message]);

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
          message.success(i18n.t("auth.login.welcomeBack"));
          router.replace("/project");
        } else {
          await authStore.register(username, password);
          message.success(i18n.t("auth.login.accountCreated"));
          router.replace("/project");
        }
      } catch (err: unknown) {
        message.error((err as Error).message || i18n.t("error.unknown"));
      } finally {
        setLoading(false);
      }
    },
    [mode, username, password, router, authStore, message]
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
    <div className="flex h-screen w-screen overflow-hidden bg-background">
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
