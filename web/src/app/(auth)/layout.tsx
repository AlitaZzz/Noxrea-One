/**
 * 未认证路由组 layout。
 * 登录 / 注册等页面无需侧边栏与顶栏，仅做 passthrough。
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
