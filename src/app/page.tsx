import { Bike } from "lucide-react";

export default function Home() {
  const convexReady = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <section className="w-full max-w-lg rounded-2xl border border-black/10 bg-white p-8 dark:border-white/10 dark:bg-zinc-950">
        <Bike className="mb-4 h-8 w-8" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">Loco Vibeathons</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Next.js、TypeScript、Tailwind、Lucide 同 Convex 環境已就緒。
        </p>
        <p className="mt-6 text-sm text-zinc-800 dark:text-zinc-200">
          Convex：{convexReady ? "本機 deployment 已寫入 .env.local" : "尚未設定 NEXT_PUBLIC_CONVEX_URL"}
        </p>
      </section>
    </main>
  );
}
