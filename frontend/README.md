This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 前端目录结构

```
frontend/src/
├── app/          # Next.js App Router 页面
├── components/   # React 组件（PascalCase，含 components/director 引擎 UI）
├── hooks/        # 自定义 hooks（kebab-case）
├── lib/          # 工具层（kebab-case）
├── providers/    # React context providers
├── stores/       # Zustand 状态管理
├── director/     # 3D 引擎逻辑（纯 TS，无 React）：core/entities/util
└── __tests__/    # 集中单元测试（*.test.ts，kebab-case）
```

命名约定与 `src/director/` 和 `src/components/director/` 的分层边界，详见仓库根目录 `CLAUDE.md` 的「前端命名规范」。
