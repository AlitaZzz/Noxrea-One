/**
 * Director 主题单一来源。
 * 集中维护 Ant Design 暗/亮双套 token 与组件级覆写，供 AppProviders 装配，
 * 避免主题配置散落在组件内部难以统一调整。
 */

import { theme as antTheme } from "antd";

/** 根据明暗模式返回 Ant Design 主题配置对象 */
export function directorTheme(isDark: boolean) {
  return {
    algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    token: isDark
      ? {
          // Director 配色（暗色）
          colorPrimary: "#3b82f6",
          borderRadius: 8,
          colorBgLayout: "#000000",
          colorBgContainer: "#0e0e11",
          colorBgElevated: "#1a1a1e",
          colorBgSpotlight: "#1a1a1e",
          colorBorder: "#2c2c31",
          colorBorderSecondary: "#232327",
          colorText: "#ececf0",
          colorTextSecondary: "#7d7d86",
          colorTextTertiary: "#56565d",
          colorTextQuaternary: "#3a3a40",
          controlOutlineWidth: 0,
        }
      : {
          colorPrimary: "#1677ff",
          borderRadius: 6,
          colorBgElevated: "#ffffff",
          colorBgContainer: "#ffffff",
          colorBgLayout: "#f8f9fa",
          colorBorder: "#d9d9d9",
        },
    components: {
      Select: {
        colorBgContainer: isDark ? "#1a1a1e" : "#ffffff",
        activeBorderColor: isDark ? "#2c2c31" : "#d9d9d9",
        hoverBorderColor: isDark ? "#2c2c31" : "#d9d9d9",
        activeOutlineColor: "transparent",
      },
      Slider: isDark
        ? {
            trackBg: "#fff",
            trackHoverBg: "#fff",
            railBg: "#3a3a40",
            railHoverBg: "#4a4a52",
            handleColor: "#fff",
            handleActiveColor: "#fff",
            // 以下两个 antd 默认均由 colorPrimary(#3b82f6) 推导，不覆盖就会变蓝：
            // 1) 手柄自身 hover/聚焦时的 6px 外圈光晕
            handleActiveOutlineColor: "transparent",
            // 2) 鼠标进入 slider 区域（含背景轨道）时重绘手柄描边
            colorPrimaryBorderHover: "#fff",
            dotActiveBorderColor: "#fff",
            handleSizeHover: 10,
            handleSize: 10,
            railSize: 2,
          }
        : {},
      Segmented: isDark
        ? {
            trackBg: "#232327",
            itemSelectedBg: "#232327",
            itemSelectedColor: "#fff",
          }
        : {},
      Switch: isDark
        ? {
            handleBg: "#000",
            colorPrimary: "#fff",
            colorPrimaryHover: "#fff",
          }
        : {},
      Checkbox: isDark
        ? {
            colorPrimary: "#ffffff",
            colorPrimaryHover: "#e6e6e6",
            colorWhite: "#1a1a1e",
          }
        : {},
    },
  };
}
