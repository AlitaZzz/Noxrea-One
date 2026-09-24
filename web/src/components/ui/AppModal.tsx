/**
 * 通用弹窗基座。
 * 在 LayerModal 之上统一居中、宽度默认值与标题下边距，全站功能弹窗均基于它构建。
 */
"use client";

import type { ReactNode } from "react";

import { LayerModal } from "@/components/ui/modal/LayerModal";

interface AppModalProps {
  title: ReactNode;
  open: boolean;
  onCancel: () => void;
  width?: number | string;
  footer?: ReactNode;
  children: ReactNode;
  /** 透传给 LayerModal；header/body/footer/container 的部分样式会与本组件的壳默认值合并 */
  styles?: {
    container?: React.CSSProperties;
    header?: React.CSSProperties;
    body?: React.CSSProperties;
    footer?: React.CSSProperties;
  };
  className?: string;
  destroyOnHidden?: boolean;
  closeIcon?: ReactNode;
  centered?: boolean;
  style?: React.CSSProperties;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传入更高值。 */
  zIndex?: number;
  /** 弹窗打开/关闭动画结束后的回调，用于自定义焦点管理 */
  afterOpenChange?: (open: boolean) => void;
  /** 贴边布局（如资产库三栏）：内容自行管理间距，去掉默认的顶部 pt-4 内边距。 */
  flush?: boolean;
  /** 挂到 document.body 呈现全屏遮罩（如破坏性二次确认），而非嵌进父 layer。 */
  global?: boolean;
  /** 是否显示遮罩（头像裁剪等无遮罩场景关闭） */
  mask?: boolean;
}

/**
 * 全站弹窗壳语言（单一来源）：容器清零、三段自控内边距，
 * header 右侧 56px 避让关闭按钮、标题行中心统一 28px（关闭按钮得以一条规则定位）。
 * 调用方经 styles 传入的部分覆盖同字段默认值；
 * footer 为 null 的弹窗需自行给 body 补底部间距（壳默认 0，间距归 footer）。
 * padding 类 token 在 v6 为 Modal 内部 token，无法经 ConfigProvider 配置，故在此声明。
 */
function withShellStyles(styles?: AppModalProps["styles"]) {
  return {
    container: { padding: 0, ...styles?.container },
    header: { padding: "16px 56px 0 24px", borderBottom: "none", marginBottom: 0, ...styles?.header },
    body: { padding: "16px 24px 0", ...styles?.body },
    footer: { padding: "16px 24px 20px", margin: 0, ...styles?.footer },
  };
}

/** 通用弹窗 - 统一标题下边距 + 居中，所有功能弹窗都用这个。 */
export default function AppModal({
  title, open, onCancel, width = 520, footer, children, styles,
  className, destroyOnHidden, closeIcon, centered = true, style, zIndex, afterOpenChange,
  flush = false, global: isGlobal = false, mask,
}: AppModalProps) {
  return (
    <LayerModal
      title={title} open={open} onCancel={onCancel}
      width={width} centered={centered} footer={footer} styles={withShellStyles(styles)}
      className={className} destroyOnHidden={destroyOnHidden} closeIcon={closeIcon}
      style={style} zIndex={zIndex} afterOpenChange={afterOpenChange} global={isGlobal} mask={mask}
    >
      {flush ? children : <div className="pt-4">{children}</div>}
    </LayerModal>
  );
}
