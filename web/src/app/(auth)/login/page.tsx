/**
 * 登录 / 注册页面。
 * 左侧为品牌展示区（自动扫描 public/login-bg 下的视频做轮播背景），
 * 右侧为登录/注册表单：自定义字段校验、密码可见切换，提交后调用 auth store
 * 完成登录或注册并跳转回根路由分流。
 */
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect,useState } from "react";

import { EyeIcon } from "@/components/ui/icons/common/EyeIcon";
import { EyeOffIcon } from "@/components/ui/icons/common/EyeOffIcon";
import { SpinnerIcon } from "@/components/ui/icons/common/SpinnerIcon";
import { useAuthStore } from "@/features/auth/store";
import { showGlobalMessage } from "@/lib/global-message";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea Canvas";

// ── Types ──

type AuthMode = "signin" | "signup";

// ── 视频轮播 ──

function VideoCarousel() {
  const [videos, setVideos] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);

  // 自动扫描 bg-v{N}.mp4，逐个探测文件是否存在
  useEffect(() => {
    const found: string[] = [];
    let cancelled = false;

    const scan = async (seq: number) => {
      if (cancelled) return;
      const name = `login-bg/bg-v${seq}`;
      try {
        const res = await fetch(`/${name}.mp4`, { method: "HEAD" });
        if (res.ok) {
          found.push(name);
          scan(seq + 1);
        } else {
          if (!cancelled) setVideos(found.length > 0 ? found : ["login-bg/bg-v1", "login-bg/bg-v2"]);
        }
      } catch {
        if (!cancelled) setVideos(found.length > 0 ? found : ["login-bg/bg-v1", "login-bg/bg-v2"]);
      }
    };

    scan(1);
    return () => { cancelled = true; };
  }, []);

  const prevVideo = videos.length > 0 ? videos[(current - 1 + videos.length) % videos.length] : "";
  const currVideo = videos.length > 0 ? videos[current] : "";

  if (videos.length === 0) {
    return <div className="absolute inset-0 bg-black" />;
  }

  return (
    <>
      {/* 上一段视频（底层，循环常驻，做交叉过渡） */}
      <video
        key={prevVideo}
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
        key={currVideo}
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

// ── 左面板 ──

function LeftPanel() {
  return (
    <div className="relative hidden lg:flex w-1/2 bg-black flex-col items-center justify-center overflow-hidden">
      {/* 视频背景 */}
      <VideoCarousel />

      <div className="absolute w-[500px] h-[500px] rounded-full bg-cyan-500/10 blur-[120px]" />

      <div className="relative z-20 text-center px-12">
        <h1 className="text-4xl font-bold text-white mb-4 tracking-tight drop-shadow-[0_0_20px_rgba(34,211,238,0.35)]">
          {APP_NAME}
        </h1>
        <p className="relative inline-block text-xl font-semibold leading-relaxed
                      bg-gradient-to-r from-cyan-300 via-sky-200 to-purple-300
                      bg-clip-text text-transparent
                      drop-shadow-[0_0_18px_rgba(168,85,247,0.25)]">
          从灵感碎片，到完整世界
          <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 h-px w-3/4
                           bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />
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

  return (
    <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-zinc-950">
      <div className="w-full max-w-[420px]">
        <div className="lg:hidden text-center mb-8">
          <div className="text-4xl mb-2">🎨</div>
          <h1 className="text-2xl font-bold text-white">{APP_NAME}</h1>
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-1">
            {isSignin ? "登录" : "创建账号"}
          </h2>
          <p className="text-zinc-400 text-sm">
            {isSignin ? `欢迎回到 ${APP_NAME}` : "开启你的创作之旅"}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              aria-invalid={!!errors.username}
              className={`w-full px-4 py-3 bg-zinc-900 border rounded-xl text-white placeholder-zinc-500
                         focus:outline-none focus:ring-1 transition-all duration-200
                         ${errors.username
                           ? "border-red-500 focus:border-red-500 focus:ring-red-500/50"
                           : "border-zinc-700 focus:border-cyan-500 focus:ring-cyan-500/50"}`}
            />
            {errors.username && (
              <p className="mt-1.5 text-sm text-red-400">{errors.username}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">密码</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                aria-invalid={!!errors.password}
                className={`w-full px-4 py-3 pr-11 bg-zinc-900 border rounded-xl text-white placeholder-zinc-500
                           focus:outline-none focus:ring-1 transition-all duration-200
                           ${errors.password
                             ? "border-red-500 focus:border-red-500 focus:ring-red-500/50"
                             : "border-zinc-700 focus:border-cyan-500 focus:ring-cyan-500/50"}`}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "隐藏密码" : "显示密码"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
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
            className="w-full py-3 rounded-xl font-semibold text-sm
                       bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-400 hover:to-purple-400
                       text-white shadow-lg shadow-cyan-500/25
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-all duration-200 active:scale-[0.98]"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <SpinnerIcon className="animate-spin h-4 w-4" />
                处理中...
              </span>
            ) : isSignin ? (
              "登录"
            ) : (
              "注册"
            )}
          </button>
        </form>

        <div className="mt-8 text-center">
          <p className="text-zinc-500 text-sm">
            {isSignin ? "还没有账号？" : "已有账号？"}{" "}
            <button
              onClick={onToggle}
              className="text-cyan-400 hover:text-cyan-300 font-medium transition-colors"
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
      if (!username.trim()) nextErrors.username = "请输入用户名";
      if (!password) nextErrors.password = "请输入密码";
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }
      setErrors({});

      setLoading(true);

      try {
        if (mode === "signin") {
          await authStore.login(username, password);
          showGlobalMessage().success("欢迎回来！");
          setTimeout(() => router.push("/"), 600);
        } else {
          await authStore.register(username, password);
          showGlobalMessage().success("账号创建成功！");
          setTimeout(() => router.push("/"), 600);
        }
      } catch (err: unknown) {
        showGlobalMessage().error((err as Error).message || "操作失败");
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
    <div className="flex h-screen w-screen bg-zinc-950 overflow-hidden">
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
