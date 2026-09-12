/**
 * Director 主题单一来源。
 * 集中维护 Ant Design 深色 token 与组件级覆写，供 AppProviders 装配，
 * 避免主题配置散落在组件内部难以统一调整。
 */

import { theme as antTheme } from "antd";

/**
 * 配色单一来源，色值与 globals.css 的 --canvas-* 语义变量一一对应，
 * 改色时两处必须同步。
 *
 * 主题：中性石墨 + 青柠。品牌强调色统一为青柠 #c7f43d
 * （accent = select = success），旧版蓝色主色 #3b82f6 已退役；
 * 中性色不带色相偏色，底色锚在 L*≈11（不用纯黑、也不取中灰），
 * 与青柠对比约 13:1，兼顾清晰与护眼。
 */
/** 品牌强调色：同 --canvas-accent / --canvas-select / --canvas-success */
const COLOR_PRIMARY = "#c7f43d";
const COLOR_PRIMARY_HOVER = "#d6f86a";
const COLOR_PRIMARY_ACTIVE = "#aede2b";
/** 主色填充上的文字色：青柠是浅色，必须配深色字，否则对比度不足 */
const ON_PRIMARY_TEXT = "#141509";
/** 警示色：同 --canvas-warning，用橙与青柠拉开色相 */
const COLOR_WARNING = "#ffb020";
/** 错误色：青柠主题下红仍是唯一的「危险」语义，保持原值 */
const COLOR_ERROR = "#ff4d4f";

/**
 * canvas 采用无彩（中性）设计语言，而 antd 会把品牌主色 colorPrimary
 * 派生到 hover / focus / 选中态的描边与阴影上，造成主色外溢。
 * 下面两个常量即无彩化用到的中性色，供各组件覆写引用。
 *
 * 注意：不要通过改 Seed 层的 colorPrimary 来达成中性化 —— 它要参与整套色板派生，
 * 且 --canvas-accent 仍依赖它（链接、加载动画、徽标等需要强调色）。
 * 中性化应在组件层完成，这正是这些常量的职责。
 */
const NEUTRAL_FILL = "#fff"; // 控件强调填充（开关 / 勾选 / 滑块手柄）
const NEUTRAL_BORDER = "#2d2d33"; // 描边，同 --canvas-border

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

/** 返回固定的深色 Ant Design 主题配置对象。 */
export function directorTheme() {
  return {
    algorithm: antTheme.darkAlgorithm,
    token: {
      // 品牌色：青柠，与 canvas 的 accent / select / success 同值
      colorPrimary: COLOR_PRIMARY,
      colorPrimaryHover: COLOR_PRIMARY_HOVER,
      colorPrimaryActive: COLOR_PRIMARY_ACTIVE,
      colorLink: COLOR_PRIMARY,
      colorLinkHover: COLOR_PRIMARY_HOVER,
      colorInfo: COLOR_PRIMARY,
      colorSuccess: COLOR_PRIMARY,
      colorWarning: COLOR_WARNING,
      colorError: COLOR_ERROR,
      borderRadius: 8,
      colorBgLayout: "#0c0c0e",
      colorBgContainer: "#151518",
      colorBgElevated: "#1d1d21",
      colorBgSpotlight: "#1d1d21",
      colorBorder: "#2d2d33",
      colorBorderSecondary: "#26262b",
      colorText: "#e7e7ec",
      colorTextSecondary: "#95959e",
      colorTextTertiary: "#76767f",
      colorTextQuaternary: "#55555d",
      controlOutlineWidth: 0,
      // 注意：这里刻意不覆写 colorTextLightSolid —— Tooltip 的文字也用它，
      // 改成深色会让深底 Tooltip 不可读；主色按钮的深色字由 Button.primaryColor 单独处理。
    },
    components: {
      Button: {
        // 青柠填充 + 深色字。单独覆写而不是改 colorTextLightSolid，
        // 因为后者被 Tooltip 等共用，改成深色会让深底 Tooltip 不可读。
        primaryColor: ON_PRIMARY_TEXT,
      },
      Select: {
        colorBgContainer: "#1d1d21",
        activeBorderColor: NEUTRAL_BORDER,
        hoverBorderColor: NEUTRAL_BORDER,
        ...NEUTRAL_OUTLINE,
      },
      Slider: {
        trackBg: NEUTRAL_FILL, trackHoverBg: NEUTRAL_FILL, railBg: "#3b3b42", railHoverBg: "#474750",
        handleColor: NEUTRAL_FILL, handleActiveColor: NEUTRAL_FILL, dotActiveBorderColor: NEUTRAL_FILL,
        handleSizeHover: 10, handleSize: 10, railSize: 2, ...NEUTRAL_DARK,
      },
      Segmented: { trackBg: "#26262b", itemSelectedBg: "#26262b", itemSelectedColor: NEUTRAL_FILL },
      Switch: { handleBg: "#0c0c0e", colorPrimary: NEUTRAL_FILL, colorPrimaryHover: NEUTRAL_FILL },
      Checkbox: { colorPrimary: NEUTRAL_FILL, colorPrimaryHover: "#e6e6e6", colorWhite: "#1d1d21" },
    },
  };
}
