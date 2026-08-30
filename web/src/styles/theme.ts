/**
 * Director 主题单一来源。
 * 集中维护 Ant Design 暗/亮双套 token 与组件级覆写，供 AppProviders 装配，
 * 避免主题配置散落在组件内部难以统一调整。
 */

import { theme as antTheme } from "antd";

/**
 * canvas 采用无彩（中性）设计语言，而 antd 会把品牌主色 colorPrimary
 * 派生到 hover / focus / 选中态的描边与阴影上，造成蓝色外溢。
 * 下面两个常量即无彩化用到的中性色，供各组件覆写引用。
 *
 * 注意：不要通过改 Seed 层的 colorPrimary 来达成中性化 —— 它要参与整套色板派生，
 * 且 --canvas-accent 仍依赖它（链接、加载动画、徽章等需要蓝色强调）。
 * 中性化应在组件层完成，这正是这些常量的职责。
 *
 * 色值与 globals.css 的 --canvas-* 语义变量对应，改色时两处需同步。
 */
const NEUTRAL_FILL = "#fff"; // 强调填充（开关 / 勾选 / 滑块手柄）
const NEUTRAL_BORDER = "#2c2c31"; // 描边，同 --canvas-border

/**
 * 深色主题下统一抹平主色外溢：边框归中性、手柄描边与光晕不再出现主色。
 * 新增无彩组件时展开它即可，避免主色从某个未覆盖的 token 漏出来。
 */
const NEUTRAL_DARK = {
  hoverBorderColor: NEUTRAL_BORDER,
  activeBorderColor: NEUTRAL_BORDER,
  colorPrimaryBorderHover: NEUTRAL_FILL,
  handleActiveOutlineColor: "transparent", // 仅 Slider 消费，其余组件忽略
} as const;

/** 明暗通用的无彩化：去掉聚焦光晕 */
const NEUTRAL_OUTLINE = { activeOutlineColor: "transparent" } as const;

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
        activeBorderColor: isDark ? NEUTRAL_BORDER : "#d9d9d9",
        hoverBorderColor: isDark ? NEUTRAL_BORDER : "#d9d9d9",
        ...NEUTRAL_OUTLINE,
      },
      Slider: isDark
        ? {
            trackBg: NEUTRAL_FILL,
            trackHoverBg: NEUTRAL_FILL,
            railBg: "#3a3a40",
            railHoverBg: "#4a4a52",
            handleColor: NEUTRAL_FILL,
            handleActiveColor: NEUTRAL_FILL,
            dotActiveBorderColor: NEUTRAL_FILL,
            handleSizeHover: 10,
            handleSize: 10,
            railSize: 2,
            // antd 默认把主色派生到手柄描边与外圈光晕，不覆盖就会变蓝（见 NEUTRAL_DARK 说明）
            ...NEUTRAL_DARK,
          }
        : {},
      Segmented: isDark
        ? {
            trackBg: "#232327",
            itemSelectedBg: "#232327",
            itemSelectedColor: NEUTRAL_FILL,
          }
        : {},
      Switch: isDark
        ? {
            handleBg: "#000",
            colorPrimary: NEUTRAL_FILL,
            colorPrimaryHover: NEUTRAL_FILL,
          }
        : {},
      Checkbox: isDark
        ? {
            colorPrimary: NEUTRAL_FILL,
            colorPrimaryHover: "#e6e6e6",
            colorWhite: "#1a1a1e",
          }
        : {},
    },
  };
}
