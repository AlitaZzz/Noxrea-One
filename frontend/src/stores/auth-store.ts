import { create } from "zustand";
import { api, setToken } from "@/lib/api";

interface UserInfo {
  id: number;
  username: string;
  role: string;
  avatar: string | null;
  theme: string;
  lang: string;
}

interface AuthState {
  user: UserInfo | null;
  loading: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAdmin: () => boolean;
  savePreference: (key: "theme" | "lang", value: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: false,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    set({ loading: true });
    try {
      const res = await api<UserInfo>("/api/auth/me");
      if (res.code === 200 && res.data) {
        set({ user: res.data });
      }
    } catch {
      // Not logged in — guest mode
    }
    set({ loading: false, initialized: true });
  },

  login: async (username, password) => {
    const res = await api<{ token: { access_token: string }; user: UserInfo }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }) }
    );
    if (res.code === 200) {
      setToken(res.data.token.access_token);
      set({ user: res.data.user });
    } else {
      throw new Error(res.msg || "Login failed");
    }
  },

  logout: () => {
    setToken(null);
    set({ user: null });
  },

  isAdmin: () => get().user?.role === "admin",

  savePreference: async (key, value) => {
    const user = get().user;
    if (!user) return;
    set({ user: { ...user, [key]: value } });
    api("/api/auth/me", { method: "PUT", body: JSON.stringify({ [key]: value }) }).catch(() => {});
  },
}));
