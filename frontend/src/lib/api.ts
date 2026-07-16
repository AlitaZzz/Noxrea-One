export const BASE = (typeof window !== "undefined"
  ? (window as any).__NEXT_PUBLIC_FASTAPI_URL
  : undefined) || process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("noxrea-auth-token");
}

export function setToken(token: string | null) {
  if (!token) {
    localStorage.removeItem("noxrea-auth-token");
  } else {
    localStorage.setItem("noxrea-auth-token", token);
  }
}

export function getTokenHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<{ code: number; data: T; msg: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...getTokenHeader(),
      ...(options.headers || {}),
    },
  });
  return res.json();
}

export async function apiUpload<T = any>(path: string, formData: FormData): Promise<{ code: number; data: T; msg: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: getTokenHeader(),
    body: formData,
  });
  const json = await res.json();
  return json;
}

export function apiUploadWithProgress<T = any>(
  path: string,
  formData: FormData,
  onProgress?: (pct: number) => void,
): Promise<{ code: number; data: T; msg: string }> {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch { reject(new Error("Parse failed")); }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData);
  });
}

// --- Asset API ---

export interface AssetFolderDto {
  id: number;
  user_id: number;
  name: string;
  space_key: string;
  parent_id: number | null;
  created_at: string;
}

export interface AssetItemDto {
  id: number;
  user_id: number;
  folder_id: number | null;
  space_key: string;
  name: string;
  type: string;
  width: number;
  height: number;
  description: string;
  tags: string[];
  extra_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Folders
export const assetApi = {
  listFolders: (spaceKey = "personal") =>
    api<AssetFolderDto[]>(`/api/assets/folders?space_key=${spaceKey}`),

  createFolder: (name: string, spaceKey = "personal", parentId?: number) =>
    api<AssetFolderDto>("/api/assets/folders", {
      method: "POST",
      body: JSON.stringify({ name, space_key: spaceKey, parent_id: parentId ?? null }),
    }),

  updateFolder: (id: number, name: string) =>
    api<AssetFolderDto>(`/api/assets/folders/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (id: number) =>
    api(`/api/assets/folders/${id}`, { method: "DELETE" }),

  // Assets
  listAssets: (params?: { folder_id?: number; type?: string; search?: string; space_key?: string }) => {
    const sp = new URLSearchParams();
    if (params?.folder_id !== undefined) sp.set("folder_id", String(params.folder_id));
    if (params?.type) sp.set("type", params.type);
    if (params?.search) sp.set("search", params.search);
    if (params?.space_key) sp.set("space_key", params.space_key);
    const qs = sp.toString();
    return api<AssetItemDto[]>(`/api/assets/items${qs ? `?${qs}` : ""}`);
  },

  createAsset: (data: {
    name: string; type: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extra_data?: Record<string, unknown>; folder_id?: number; space_key?: string;
  }) =>
    api<AssetItemDto>("/api/assets/items", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  createAssetsBatch: (items: Array<{
    name: string; type: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extra_data?: Record<string, unknown>; folder_id?: number; space_key?: string;
  }>) =>
    api<AssetItemDto[]>("/api/assets/items/batch", {
      method: "POST",
      body: JSON.stringify(items),
    }),

  updateAsset: (id: number, data: Record<string, unknown>) =>
    api<AssetItemDto>(`/api/assets/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteAsset: (id: number) =>
    api(`/api/assets/items/${id}`, { method: "DELETE" }),

  updateAssetsBatch: (ids: number[], updates: Record<string, unknown>) =>
    api<{ count: number }>("/api/assets/items/batch", {
      method: "PUT",
      body: JSON.stringify({ ids, updates }),
    }),
};
