/**
 * 全局通知 API - 在 React 组件外也能调用 antd notification（右下角卡片）。
 *
 * 使用方式：
 * 1. App 初始化时将 App.useApp() 返回的 notification 实例注册进来（见 AppProviders.tsx）
 * 2. 任意位置调 showGlobalNotification().error({ title, description })
 *
 * 若尚未注册（极早时机），fallback 到 antd 静态 notification。
 */
import { notification as antdNotification } from "antd";

interface NotificationOptions {
  title: string;
  description?: string;
  placement?: "bottomRight";
  duration?: number;
  /** 去重标识：同来源重复触发的通知传同一 key，后到的替换先到的而不是堆叠 */
  key?: string;
}

type NotificationApi = {
  error: (opts: NotificationOptions) => void;
  success: (opts: NotificationOptions) => void;
  info: (opts: NotificationOptions) => void;
  warning: (opts: NotificationOptions) => void;
};

let _notifApi: NotificationApi | null = null;

export function setGlobalNotificationApi(api: NotificationApi) {
  _notifApi = api;
}

function adapt(instance: typeof antdNotification): NotificationApi {
  return {
    error: (o) => instance.error({ title: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration, key: o.key }),
    success: (o) => instance.success({ title: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration, key: o.key }),
    info: (o) => instance.info({ title: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration, key: o.key }),
    warning: (o) => instance.warning({ title: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration, key: o.key }),
  };
}

export function showGlobalNotification(): NotificationApi {
  return (
    _notifApi ?? adapt(antdNotification)
  );
}
