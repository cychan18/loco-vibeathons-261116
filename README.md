# Loco Vibeathons

減少共享單車巡邏隊的無效現場出勤。技術棧是 Next.js App Router（`src/`）、TypeScript、Tailwind CSS、Lucide React、Convex。

## 開發

```bash
npm install
npm run dev
```

`npm run dev` 會同時啟動本機 Convex deployment 同 Next.js（[http://localhost:3000](http://localhost:3000)）。

只開其中一邊：

```bash
npm run dev:backend
npm run dev:frontend
```

第一次執行會在 `.env.local` 寫入 `CONVEX_DEPLOYMENT` 同 `NEXT_PUBLIC_CONVEX_URL`，並產生 `convex/_generated`（這份生成碼要提交）。`.env.local` 同本機資料目錄 `.convex/` 不要提交。
