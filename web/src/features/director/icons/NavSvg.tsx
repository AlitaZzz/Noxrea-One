/**
 * 导演台导航小地图的 SVG 容器，承载动态绘制的方位指示，供运行时按 id 查询。
 */
import type { CSSProperties,ReactNode } from "react";

interface NavSvgProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * 导演视图导航小地图容器（SVG 承载动态矩形/圆点）。
 * 抽离自 DirectorViewport，保持原样式与 id，供脚本查询使用。
 */
export function NavSvg({ children, className, style }: NavSvgProps) {
  return (
    <svg
      id="navsvg"
      width="74"
      height="74"
      viewBox="0 0 74 74"
      className={className}
      style={{
        display: "block",
        background: "rgba(0,0,0,.5)",
        border: "1px solid var(--dir-line2)",
        borderRadius: "50%",
        ...style,
      }}
    >
      {children}
    </svg>
  );
}

export default NavSvg;
