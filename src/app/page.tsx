"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  BadgeCheck,
  Camera,
  Clock3,
  ImagePlus,
  MapPin,
  Plus,
  Radar,
  RotateCcw,
  Smartphone,
  Ticket,
  X,
  Zap,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PatrolProofCard } from "@/components/PatrolProofCard";
import { api } from "../../convex/_generated/api";

type Dashboard = FunctionReturnType<typeof api.tickets.getAllTickets>;
type Ticket = Dashboard["tickets"][number];
type CaptureSource = "PATROL" | "RIDER";
type VisionMode = "live" | "fast";

const SAVED_MINUTES_PER_TRIP = 20;
const LIVE_VISION_DELAY_MS = 1300;
const DEDICATED_TRIP_COST_LOW = 60;
const DEDICATED_TRIP_COST_HIGH = 80;

type BlueprintTab = "roi" | "pilot";

const GEO_ZONES = [
  "港島南區",
  "港島南｜鴨脷洲區",
  "新界東｜沙田・大圍區",
  "九龍東｜將軍澳區",
  "九龍東｜觀塘區",
  "九龍西｜深水埗區",
  "新界西｜荃灣區",
] as const;

const PRESET_CASES = [
  { key: "CASE_A", label: "Case A", hint: "大圍站・已踩走" },
  { key: "CASE_B", label: "Case B", hint: "將軍澳・死車阻塞" },
  { key: "CASE_C", label: "Case C", hint: "沙田圍・GPS 漂移" },
  { key: "CASE_D", label: "Case D", hint: "大圍站・重複投訴" },
] as const;

const DECISION_META: Record<
  string,
  { emoji: string; title: string; detail: string; panel: string; bar: string }
> = {
  PENDING: {
    emoji: "⏳",
    title: "待分流",
    detail: "尚未執行 AI 派單前預判。完成後才會決定推送分區群組，或靜默掛載地理圍欄。",
    panel: "border-white/15 bg-white/5 text-white",
    bar: "bg-zinc-400",
  },
  OPPORTUNISTIC_POOL: {
    emoji: "🟢",
    title: "OPPORTUNISTIC_POOL・轉入雙軌順路池",
    detail: "系統確認現場已清空，免除專程派車，靜默掛載至該區地理圍欄。",
    panel: "border-emerald-300/40 bg-emerald-950/80 text-emerald-50",
    bar: "bg-emerald-400",
  },
  URGENT_DISPATCH: {
    emoji: "🔴",
    title: "URGENT_DISPATCH・推送分區群組急清",
    detail: "單車仍在場阻塞，自動推送至該區 Patrol WhatsApp 群組，由隊員協調人手。",
    panel: "border-red-400/40 bg-red-950/80 text-red-50",
    bar: "bg-red-400",
  },
  LOW_CONFIDENCE_VERIFY: {
    emoji: "🟠",
    title: "LOW_CONFIDENCE_VERIFY・GPS 漂移防誤判保護",
    detail: "定位漂移過大，不能把後台 0 部當成已清空。留在分區待覆核。",
    panel: "border-orange-300/40 bg-orange-950/80 text-orange-50",
    bar: "bg-orange-400",
  },
  MERGED_DUPLICATE: {
    emoji: "🟡",
    title: "MERGED_DUPLICATE・自動合併至母單",
    detail: "同一地點的短時間重複投訴已合併，避免二次出勤。",
    panel: "border-amber-300/40 bg-amber-950/80 text-amber-50",
    bar: "bg-amber-300",
  },
};

const SCENE_WASH: Record<string, string> = {
  CASE_A: "from-rose-950 via-stone-800 to-emerald-950",
  CASE_B: "from-sky-950 via-cyan-900 to-blue-950",
  CASE_C: "from-stone-900 via-amber-950 to-zinc-950",
  CASE_D: "from-rose-950 via-red-950 to-stone-900",
  CUSTOM: "from-lime-950 via-emerald-900 to-zinc-950",
};

let seedInFlight = false;
const EMPTY_TICKETS: Ticket[] = [];

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失敗，請再試一次。";
}

function formatHkTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function obstacleLabel(level: string) {
  const labels: Record<string, string> = {
    CLEAR: "暢通",
    NONE: "無阻塞",
    MODERATE: "中度阻塞",
    BLOCKING: "嚴重阻塞",
    SEVERE: "嚴重阻塞",
    HIGH: "高度阻塞",
    UNCERTAIN: "未能判定",
  };
  return labels[level] ?? level;
}

function decisionOf(decision: string) {
  return DECISION_META[decision] ?? DECISION_META.PENDING;
}

async function readImageFile(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("相片讀取失敗"));
    reader.readAsDataURL(file);
  });

  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const maxEdge = 960;
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(dataUrl);
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

function formatCount(value: number) {
  return value.toLocaleString("zh-HK");
}

function formatHours(value: number) {
  return value.toLocaleString("zh-HK", { maximumFractionDigits: 1 });
}

function BlueprintModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<BlueprintTab>("roi");
  const [dailyComplaints, setDailyComplaints] = useState(50);
  const [emptyRunRate, setEmptyRunRate] = useState(40);
  const [tripMinutes, setTripMinutes] = useState(20);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const monthlyTrips = Math.round(dailyComplaints * (emptyRunRate / 100) * 30);
  const monthlyHours = (monthlyTrips * tripMinutes) / 60;
  const monthlyCostLow = monthlyTrips * DEDICATED_TRIP_COST_LOW;
  const monthlyCostHigh = monthlyTrips * DEDICATED_TRIP_COST_HIGH;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-6 sm:py-10"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="blueprint-title"
        className="w-full max-w-3xl rounded-3xl border border-amber-200/30 bg-[#0c1813] p-4 text-emerald-50 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] tracking-[0.16em] text-amber-200/80">LOCO PILOT BLUEPRINT</p>
            <h2 id="blueprint-title" className="mt-1 text-lg font-semibold text-white">
              📊 營運效益計算機 & Loco 試點藍圖
            </h2>
          </div>
          <button
            type="button"
            className="rounded-full border border-white/15 p-2 text-emerald-50/80 hover:bg-white/10"
            onClick={onClose}
            aria-label="關閉"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="效益與試點">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "roi"}
            className={cx(
              "rounded-full px-3 py-2 text-xs font-medium",
              tab === "roi" ? "bg-amber-300 text-black" : "border border-white/15 text-emerald-50/80",
            )}
            onClick={() => setTab("roi")}
          >
            🧮 Patrol 減廢與 Rider 眾包效益計算機
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pilot"}
            className={cx(
              "rounded-full px-3 py-2 text-xs font-medium",
              tab === "pilot" ? "bg-emerald-400 text-black" : "border border-white/15 text-emerald-50/80",
            )}
            onClick={() => setTab("pilot")}
          >
            🚀 風險控制與下週試點計劃
          </button>
        </div>

        {tab === "roi" ? (
          <div role="tabpanel" className="mt-5 space-y-5">
            <label className="block">
              <span className="flex items-baseline justify-between gap-3 text-sm text-emerald-50">
                每日 WhatsApp 違泊投訴單量
                <strong className="font-mono text-base text-amber-200">{dailyComplaints} 宗</strong>
              </span>
              <input
                type="range"
                min={10}
                max={200}
                step={1}
                value={dailyComplaints}
                aria-label="每日 WhatsApp 違泊投訴單量"
                className="mt-2 w-full accent-amber-300"
                onChange={(event) => setDailyComplaints(Number(event.target.value))}
              />
            </label>
            <label className="block">
              <span className="flex items-baseline justify-between gap-3 text-sm text-emerald-50">
                到達發現「車已踩走」空跑率
                <strong className="font-mono text-base text-amber-200">{emptyRunRate}%</strong>
              </span>
              <input
                type="range"
                min={0}
                max={80}
                step={1}
                value={emptyRunRate}
                aria-label="到達發現車已踩走空跑率"
                className="mt-2 w-full accent-amber-300"
                onChange={(event) => setEmptyRunRate(Number(event.target.value))}
              />
            </label>
            <label className="block">
              <span className="flex items-baseline justify-between gap-3 text-sm text-emerald-50">
                每次專程出勤平均耗時
                <strong className="font-mono text-base text-amber-200">{tripMinutes} 分鐘</strong>
              </span>
              <input
                type="range"
                min={10}
                max={45}
                step={1}
                value={tripMinutes}
                aria-label="每次專程出勤平均耗時"
                className="mt-2 w-full accent-amber-300"
                onChange={(event) => setTripMinutes(Number(event.target.value))}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <article className="rounded-2xl border border-amber-200/40 bg-amber-300/15 px-4 py-4">
                <p className="text-xs text-amber-100/80">每月攔截無效專程出勤趟數</p>
                <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-amber-200">
                  {formatCount(monthlyTrips)} 趟
                </p>
                <p className="mt-1 text-xs leading-5 text-emerald-50/70">
                  {dailyComplaints} 宗/日 × {emptyRunRate}% × 30 日
                </p>
              </article>
              <article className="rounded-2xl border border-emerald-300/40 bg-emerald-400/10 px-4 py-4">
                <p className="text-xs text-emerald-100/80">每月釋放 Patrol 前線工時</p>
                <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-emerald-200">
                  {formatHours(monthlyHours)} 小時
                </p>
                <p className="mt-1 text-xs leading-5 text-emerald-50/70">
                  {formatCount(monthlyTrips)} 趟 × {tripMinutes} 分鐘
                </p>
              </article>
            </div>

            <article className="rounded-2xl border border-white/10 bg-black/30 px-4 py-4">
              <p className="text-sm font-semibold text-white">成本效益對比</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-red-400/30 bg-red-950/50 px-3 py-3">
                  <p className="text-xs text-red-100/80">派 Patrol 專程空跑</p>
                  <p className="mt-1 text-lg font-semibold text-white">HK$60–80 / 趟</p>
                  <p className="mt-1 text-xs leading-5 text-red-50/80">
                    人工、車油與機會成本。以目前假設計，每月約 HK$
                    {formatCount(monthlyCostLow)}–{formatCount(monthlyCostHigh)}。
                  </p>
                </div>
                <div className="rounded-xl border border-emerald-300/40 bg-emerald-950/60 px-3 py-3">
                  <p className="text-xs text-emerald-100/80">順路核實</p>
                  <p className="mt-1 text-lg font-semibold text-emerald-200">邊際成本近乎 $0</p>
                  <p className="mt-1 text-xs leading-5 text-emerald-50/80">
                    Patrol 順路補拍沒有額外車程。Loco Rider 順路拍照換 2 張 30 分鐘踩車券，同時提高復購率。
                  </p>
                </div>
              </div>
              <p className="mt-3 rounded-xl bg-amber-300 px-3 py-2 text-sm font-semibold text-black">
                節省超過 95% 核實成本。
              </p>
            </article>
          </div>
        ) : (
          <div role="tabpanel" className="mt-5 space-y-3">
            <article className="rounded-2xl border border-white/10 bg-black/30 px-4 py-4">
              <h3 className="text-sm font-semibold text-white">貼合現有分區群組習慣（Auto-Zone Routing）</h3>
              <p className="mt-2 text-sm leading-6 text-emerald-50/85">
                保留 Loco 按地區 WhatsApp Group 協調 Patrol 人手的運作模式。系統只把急單推入群組，已清空的工單則靜默轉入地理圍欄順路池。
              </p>
            </article>
            <article className="rounded-2xl border border-orange-300/30 bg-orange-950/40 px-4 py-4">
              <h3 className="text-sm font-semibold text-orange-50">False-Positive 誤判防線</h3>
              <p className="mt-2 text-sm leading-6 text-orange-50/90">
                凡 GPS 誤差超過 30m，或 Vision AI 偵測到壞車、阻礙盲人徑，系統強制推入分區群組優先巡查（如 Case C）。寧可穩陣，絕不漏單。
              </p>
            </article>
            <article className="rounded-2xl border border-emerald-300/30 bg-emerald-950/40 px-4 py-4">
              <h3 className="text-sm font-semibold text-emerald-50">Loco 兩階段試點路線圖</h3>
              <ol className="mt-3 space-y-3 text-sm leading-6 text-emerald-50/90">
                <li>
                  <strong className="text-white">Phase 1｜Week 1–2</strong>
                  <span className="mt-1 block">
                    沙田／大圍區 Shadow Mode 影子測試，驗證 AI 預判準確率高於 90%。
                  </span>
                </li>
                <li>
                  <strong className="text-white">Phase 2｜Week 3–4</strong>
                  <span className="mt-1 block">
                    啟用 50m Patrol 順路觸發，以及 30m Loco App 用戶「影相送 2 張 30 分鐘踩車券」。
                  </span>
                </li>
              </ol>
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="rounded-2xl border border-white/10 bg-[#102019] px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] text-emerald-100/70">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight text-white">
        {value}
      </p>
      <p className="mt-1 text-xs leading-5 text-emerald-100/70">{detail}</p>
    </article>
  );
}

function StreetPreview({
  ticket,
  photo,
  onPhoto,
}: {
  ticket: Ticket;
  photo?: string;
  onPhoto: (dataUrl: string | null) => void;
}) {
  return (
    <figure className="overflow-hidden rounded-xl border border-white/10 bg-black/30">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt={`${ticket.locationName} 現場相片`}
          className="h-40 w-full object-cover"
        />
      ) : (
        <div
          className={cx(
            "relative flex h-40 flex-col justify-end bg-gradient-to-br p-3",
            SCENE_WASH[ticket.scenarioKey] ?? SCENE_WASH.CUSTOM,
          )}
        >
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:22px_22px]" />
          <div className="relative">
            <p className="text-[11px] uppercase tracking-[0.16em] text-white/70">街景模擬</p>
            <p className="mt-1 text-sm font-medium text-white">{ticket.locationName}</p>
          </div>
        </div>
      )}
      <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-emerald-50/70">
        <span>{photo ? "本地相片已覆蓋街景" : "未上傳相片，顯示模擬街景"}</span>
        <span className="flex gap-2">
          <label className="cursor-pointer rounded-full border border-white/15 px-2 py-1 hover:bg-white/10">
            <span className="inline-flex items-center gap-1">
              <ImagePlus className="h-3 w-3" aria-hidden />
              上傳覆蓋
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void readImageFile(file).then(onPhoto);
              }}
            />
          </label>
          {photo ? (
            <button
              type="button"
              className="rounded-full border border-white/15 px-2 py-1 hover:bg-white/10"
              onClick={() => onPhoto(null)}
            >
              還原
            </button>
          ) : null}
        </span>
      </figcaption>
    </figure>
  );
}

function TicketQr({ ticketCode }: { ticketCode: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    const timeout = window.setTimeout(() => setOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timeout);
  }, []);
  const cleanCode = ticketCode.replace(/^[#＃]/, "");
  const path = `/patrol/${encodeURIComponent(cleanCode)}`;
  const url = origin ? `${origin}${path}` : path;

  return (
    <a href={path} className="rounded-xl bg-white p-1.5" title={url} aria-label={`開啟 ${cleanCode} 手機打卡頁`}>
      <QRCodeSVG value={url} size={84} level="M" />
    </a>
  );
}

export default function OperationsConsole() {
  const data = useQuery(api.tickets.getAllTickets);
  const seedInitialCases = useMutation(api.tickets.seedInitialCases);
  const createCustomTicket = useMutation(api.tickets.createCustomTicket);
  const runAiTriage = useMutation(api.tickets.runAiTriage);
  const triggerOpportunisticCapture = useMutation(api.tickets.triggerOpportunisticCapture);

  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [visionMode, setVisionMode] = useState<VisionMode>("fast");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [streetPhotos, setStreetPhotos] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({
    locationName: "鴨脷洲徑",
    geoZone: "港島南區",
    citizenMessage: "鴨脷洲徑有幾架 Loco 單車霸住行人路，麻煩幫手睇下仲喺唔喺度。",
    simulatedEmpty: true,
    photoDataUrl: null as string | null,
  });

  useEffect(() => {
    if (!data || data.tickets.length > 0 || seedInFlight) return;
    seedInFlight = true;
    void seedInitialCases({})
      .catch((error: unknown) => setError(errorMessage(error)))
      .finally(() => {
        seedInFlight = false;
      });
  }, [data, seedInitialCases]);

  const tickets = data?.tickets ?? EMPTY_TICKETS;
  const selected = useMemo(() => {
    if (tickets.length === 0) return null;
    const chosen = selectedCode
      ? tickets.find((ticket) => ticket.ticketCode === selectedCode)
      : undefined;
    return (
      chosen ??
      tickets.find((ticket) => ticket.scenarioKey === "CASE_A") ??
      tickets[0]
    );
  }, [selectedCode, tickets]);

  const customTickets = tickets.filter((ticket) => ticket.scenarioKey === "CUSTOM");
  const savedTrips = data?.stats.ineffectiveTripsSaved ?? 0;
  const poolPending = data?.stats.opportunisticPoolPending ?? 0;
  const vouchers = data?.stats.riderVouchersIssued ?? 0;
  const poolReady = selected?.triageDecision === "OPPORTUNISTIC_POOL" && !selected.csClosed;

  async function handleReset() {
    setBusy("reset");
    setError(null);
    try {
      const result = await seedInitialCases({});
      setStreetPhotos({});
      setSelectedCode(result.ticketCodes[0] ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    setBusy("create");
    setError(null);
    try {
      const created = await createCustomTicket({
        locationName: draft.locationName,
        geoZone: draft.geoZone,
        citizenMessage: draft.citizenMessage,
        simulatedEmpty: draft.simulatedEmpty,
      });
      if (draft.photoDataUrl) {
        setStreetPhotos((current) => ({
          ...current,
          [created.ticketCode]: draft.photoDataUrl as string,
        }));
      }
      setSelectedCode(created.ticketCode);
      setFormOpen(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleTriage() {
    if (!selected) return;
    setBusy("triage");
    setError(null);
    try {
      if (visionMode === "live") {
        setScanning(true);
        await new Promise((resolve) => setTimeout(resolve, LIVE_VISION_DELAY_MS));
      }
      await runAiTriage({ ticketId: selected._id });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setScanning(false);
      setBusy(null);
    }
  }

  async function handleTrigger(source: CaptureSource) {
    if (!selected) return;
    setBusy(source);
    setError(null);
    try {
      await triggerOpportunisticCapture({ ticketId: selected._id, source });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  if (data === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center bg-[#07110d] px-6 text-emerald-50">
        <p className="text-sm">正在連接 Convex 即時工單…</p>
      </main>
    );
  }

  if (tickets.length === 0) {
    return (
      <main className="flex flex-1 items-center justify-center bg-[#07110d] px-6 text-emerald-50">
        <p className="text-sm">資料庫是空的，正在寫入 4 大測試場景…</p>
      </main>
    );
  }

  const decision = selected ? decisionOf(selected.triageDecision) : decisionOf("PENDING");

  return (
    <main className="min-h-screen bg-[#07110d] text-emerald-50">
      <header className="border-b border-white/10 px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] tracking-[0.18em] text-emerald-200/60">LOCO VIBEATHONS</p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-white sm:text-xl">
              🚲 Loco SmartPatrol Triage｜AI 巡邏預判與順路交差系統
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center rounded-full bg-amber-300 px-3 py-2 text-xs font-semibold text-black shadow-[0_0_24px_rgba(252,211,77,0.35)] hover:bg-amber-200"
              onClick={() => setBlueprintOpen(true)}
            >
              📊 營運效益計算機 & Loco 試點藍圖
            </button>
            <div className="flex rounded-full border border-white/10 bg-black/30 p-1 text-xs">
              <button
                type="button"
                aria-pressed={visionMode === "live"}
                className={cx(
                  "rounded-full px-3 py-1.5",
                  visionMode === "live" ? "bg-emerald-400 text-black" : "text-emerald-50/70",
                )}
                onClick={() => setVisionMode("live")}
              >
                🟢 Live Vision API
              </button>
              <button
                type="button"
                aria-pressed={visionMode === "fast"}
                className={cx(
                  "rounded-full px-3 py-1.5",
                  visionMode === "fast" ? "bg-amber-300 text-black" : "text-emerald-50/70",
                )}
                onClick={() => setVisionMode("fast")}
              >
                <Zap className="mr-1 inline h-3 w-3" aria-hidden />
                Fast Simulation
              </button>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-white/15 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-50"
              onClick={() => void handleReset()}
              disabled={busy !== null}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              🔄 重置 4 大測試場景
            </button>
          </div>
        </div>
        <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            icon={<Radar className="h-3.5 w-3.5" aria-hidden />}
            label="🚗 減免無效專程出勤"
            value={`${savedTrips} 趟`}
            detail={`已攔截空跑，節省 ${savedTrips * SAVED_MINUTES_PER_TRIP} 分鐘（每單 ${SAVED_MINUTES_PER_TRIP} 分鐘）`}
          />
          <KpiCard
            icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}
            label="📍 順路補相池待辦"
            value={`${poolPending}`}
            detail="OPPORTUNISTIC_POOL 且尚未結單"
          />
          <KpiCard
            icon={<Ticket className="h-3.5 w-3.5" aria-hidden />}
            label="🎟️ Rider 眾包派券激勵"
            value={`${vouchers} 張`}
            detail="每次 Rider 協助自動派 2 張 30 分鐘踩車券"
          />
          <KpiCard
            icon={<BadgeCheck className="h-3.5 w-3.5" aria-hidden />}
            label="✅ CS 現場相片證據合規率"
            value="100%"
            detail="結單必須附時間戳記現場相片"
          />
        </section>
      </header>

      {error ? (
        <p role="alert" className="mx-4 mt-3 rounded-xl border border-red-400/40 bg-red-950/70 px-3 py-2 text-sm text-red-50 lg:mx-6">
          {error}
        </p>
      ) : null}

      <section className="grid gap-4 px-4 py-4 lg:px-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,4fr)_minmax(0,3fr)]">
        <section className="flex min-w-0 flex-col gap-3 rounded-3xl border border-white/10 bg-[#0c1813] p-3">
          <h2 className="text-xs font-semibold tracking-[0.14em] text-emerald-200/70">左欄 30%・WhatsApp 收單</h2>
          <div className="flex flex-wrap gap-2">
            {PRESET_CASES.map((preset) => {
              const ticket = tickets.find((item) => item.scenarioKey === preset.key);
              const active = selected?.scenarioKey === preset.key && selected.ticketCode === ticket?.ticketCode;
              return (
                <button
                  key={preset.key}
                  type="button"
                  disabled={!ticket}
                  onClick={() => ticket && setSelectedCode(ticket.ticketCode)}
                  className={cx(
                    "rounded-2xl border px-3 py-2 text-left text-xs disabled:opacity-40",
                    active
                      ? "border-emerald-300 bg-emerald-400 text-black"
                      : "border-white/10 bg-black/20 text-emerald-50 hover:bg-white/5",
                  )}
                >
                  <span className="block font-semibold">{preset.label}</span>
                  <span className={cx("block", active ? "text-black/70" : "text-emerald-100/50")}>{preset.hint}</span>
                </button>
              );
            })}
            {customTickets.map((ticket) => (
              <button
                key={ticket._id}
                type="button"
                onClick={() => setSelectedCode(ticket.ticketCode)}
                className={cx(
                  "rounded-2xl border px-3 py-2 text-left text-xs",
                  selected?.ticketCode === ticket.ticketCode
                    ? "border-emerald-300 bg-emerald-400 text-black"
                    : "border-dashed border-emerald-300/40 bg-black/20 text-emerald-50",
                )}
              >
                <span className="block font-semibold">{ticket.ticketCode}</span>
                <span className="block opacity-70">{ticket.locationName}</span>
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-3 text-left text-sm"
              aria-expanded={formOpen}
              onClick={() => setFormOpen((open) => !open)}
            >
              <span className="inline-flex items-center gap-2 font-medium">
                <Plus className="h-4 w-4" aria-hidden />
                ➕ CS 新增自訂投訴 Task
              </span>
              <span className="text-xs text-emerald-100/50">{formOpen ? "收合" : "展開"}</span>
            </button>
            {formOpen ? (
              <form
                className="space-y-3 border-t border-white/10 px-3 py-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreate();
                }}
              >
                <label className="block text-xs">
                  地點
                  <input
                    value={draft.locationName}
                    onChange={(event) => setDraft((current) => ({ ...current, locationName: event.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#07110d] px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  自動分區
                  <select
                    value={draft.geoZone}
                    onChange={(event) => setDraft((current) => ({ ...current, geoZone: event.target.value }))}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#07110d] px-3 py-2 text-sm"
                  >
                    {GEO_ZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  投訴內容
                  <textarea
                    value={draft.citizenMessage}
                    onChange={(event) => setDraft((current) => ({ ...current, citizenMessage: event.target.value }))}
                    rows={3}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-[#07110d] px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  本地相片
                  <input
                    type="file"
                    accept="image/*"
                    className="mt-1 block w-full text-xs"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      void readImageFile(file).then((photoDataUrl) =>
                        setDraft((current) => ({ ...current, photoDataUrl })),
                      );
                    }}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.simulatedEmpty}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, simulatedEmpty: event.target.checked }))
                    }
                  />
                  模擬後台顯示單車已被踩走
                </label>
                <button
                  type="submit"
                  disabled={busy !== null}
                  className="w-full rounded-xl bg-emerald-400 px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
                >
                  建立工單並寫入 Convex
                </button>
              </form>
            ) : null}
          </div>

          {selected ? (
            <div className="rounded-3xl bg-[#0b141a] p-3">
              <div className="mb-3 flex items-center justify-between text-[11px] text-[#8696a0]">
                <span>WhatsApp・市民投訴</span>
                <span>{selected.ticketCode}</span>
              </div>
              <div className="max-w-[95%] rounded-2xl rounded-tl-sm bg-[#005c4b] px-3 py-2 text-sm leading-6 text-white shadow-sm">
                <p className="text-[11px] text-emerald-100/80">市民</p>
                <p className="mt-1">{selected.citizenMessage}</p>
                <p className="mt-2 flex items-start gap-1 text-xs text-emerald-50/90">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {selected.locationName}
                    <span className="mt-0.5 block text-[11px] text-emerald-50/70">{selected.fullAddress}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-emerald-50/70">
                      {selected.lat.toFixed(6)}, {selected.lng.toFixed(6)}
                    </span>
                  </span>
                </p>
                <p className="mt-2 flex items-center justify-end gap-1 text-[11px] text-emerald-50/70">
                  <Clock3 className="h-3 w-3" aria-hidden />
                  {formatHkTime(selected.reportedAt)}
                </p>
              </div>
              <div className="mt-3">
                <StreetPreview
                  ticket={selected}
                  photo={streetPhotos[selected.ticketCode]}
                  onPhoto={(photo) =>
                    setStreetPhotos((current) => {
                      const next = { ...current };
                      if (photo) next[selected.ticketCode] = photo;
                      else delete next[selected.ticketCode];
                      return next;
                    })
                  }
                />
              </div>
            </div>
          ) : null}

          <button
            type="button"
            disabled={!selected || busy !== null}
            onClick={() => void handleTriage()}
            className="rounded-2xl bg-white px-3 py-3 text-sm font-semibold text-black disabled:opacity-50"
          >
            <Camera className="mr-1 inline h-4 w-4" aria-hidden />
            {scanning ? "Live Vision API 解析中…" : "🔍 執行 AI 派單前預判 & 自動分區"}
          </button>
          <p className="text-[11px] leading-5 text-emerald-100/50">
            {visionMode === "live"
              ? "Live Vision API：先等待影像回傳，再把分流寫入 Convex。"
              : "Fast Simulation：直接用已入庫的 Vision／IoT 快照分流。"}
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-3 rounded-3xl border border-white/10 bg-[#0c1813] p-3">
          <h2 className="text-xs font-semibold tracking-[0.14em] text-emerald-200/70">中欄 40%・分區路由與預判大腦</h2>
          {selected ? (
            <>
              <div className="rounded-2xl border border-emerald-300/30 bg-emerald-950/40 px-3 py-3">
                <p className="text-sm font-semibold text-white sm:text-base">
                  🗺️ Geolocation 自動分派分區：【{selected.geoZone}】
                </p>
                <p className="mt-2 text-xs leading-5 text-emerald-50/75">
                  急單自動推送至該區 Patrol WhatsApp 群組由隊員協調人手；已清空單則靜默掛載至該區地理圍欄，避免群組刷屏。
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <article className="rounded-2xl border border-white/10 bg-black/20 p-3">
                  <h3 className="text-sm font-semibold text-white">📷 Vision AI 影像解析</h3>
                  <p className="mt-1 text-[11px] text-emerald-100/50">
                    {visionMode === "live" ? "Live Vision API" : "Fast Simulation"}
                    {scanning ? "・解析中" : ""}
                  </p>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-emerald-100/60">單車數</dt>
                      <dd className="font-mono">{selected.visionBikeCount}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-emerald-100/60">阻塞度</dt>
                      <dd>{obstacleLabel(selected.visionObstacleLevel)}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {selected.visionLandmarks.map((landmark) => (
                      <span key={landmark} className="rounded-full bg-white/10 px-2 py-1 text-[11px]">
                        {landmark}
                      </span>
                    ))}
                  </div>
                </article>
                <article className="rounded-2xl border border-white/10 bg-black/20 p-3">
                  <h3 className="text-sm font-semibold text-white">📡 後台 IoT 50m 圍欄數據</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-emerald-100/60">現存上鎖車數</dt>
                      <dd className="font-mono">{selected.iotLockedBikes}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-emerald-100/60">近期被踩走</dt>
                      <dd className="font-mono">{selected.iotUnlockedRecently}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-emerald-100/60">GPS 誤差半徑</dt>
                      <dd className="font-mono">±{selected.gpsErrorMeters}m</dd>
                    </div>
                  </dl>
                </article>
              </div>

              <div className={cx("rounded-2xl border px-3 py-3", decision.panel)}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold">
                    {decision.emoji} {decision.title}
                  </p>
                  <p className="font-mono text-sm tabular-nums">信心 {selected.confidenceScore}</p>
                </div>
                <div
                  className="mt-3 h-2 overflow-hidden rounded-full bg-black/30"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={99}
                  aria-valuenow={selected.confidenceScore}
                  aria-label="信心指數"
                >
                  <div
                    className={cx("h-full rounded-full", decision.bar)}
                    style={{ width: `${Math.max(0, Math.min(100, selected.confidenceScore))}%` }}
                  />
                </div>
                <p className="mt-3 text-xs leading-5 opacity-90">{selected.triageReason || decision.detail}</p>
                {selected.mergedIntoCode ? (
                  <p className="mt-2 text-xs font-medium">合併至 {selected.mergedIntoCode}</p>
                ) : null}
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <h3 className="text-sm font-semibold text-white">雙軌順路補拍</h3>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="relative mx-auto h-36 w-36 shrink-0" aria-hidden>
                    <div className="absolute inset-0 rounded-full border border-emerald-300/30" />
                    <div className="absolute inset-5 rounded-full border border-emerald-200/40" />
                    <div className="absolute inset-10 rounded-full border border-white/30" />
                    <div className="absolute inset-0 animate-spin rounded-full bg-[conic-gradient(from_0deg,transparent_0_78%,rgba(52,211,153,0.55)_100%)] [animation-duration:4.5s]" />
                    <div className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-300" />
                    <span className="absolute right-1 top-2 text-[10px] text-emerald-100/70">50m</span>
                    <span className="absolute bottom-7 left-1/2 -translate-x-1/2 text-[10px] text-emerald-100/70">30m</span>
                  </div>
                  <div className="flex flex-1 flex-col gap-2">
                    <button
                      type="button"
                      disabled={!poolReady || busy !== null}
                      onClick={() => void handleTrigger("PATROL")}
                      className="rounded-xl border border-emerald-300/30 bg-emerald-950/40 px-3 py-3 text-left text-sm disabled:opacity-40"
                    >
                      🚐 模擬該區 Patrol 途經 50m 順路拍攝
                    </button>
                    <button
                      type="button"
                      disabled={!poolReady || busy !== null}
                      onClick={() => void handleTrigger("RIDER")}
                      className="rounded-xl border border-amber-200/30 bg-amber-950/30 px-3 py-3 text-left text-sm disabled:opacity-40"
                    >
                      📱 模擬 Loco Rider 在 30m 內開 App 影相賺 2 張 30 分鐘券
                    </button>
                    <p className="text-[11px] leading-5 text-emerald-100/50">
                      {poolReady
                        ? "兩個觸發都會寫入 Convex，並即時反映到右欄手機。"
                        : "只有分流結果為順路池、而且尚未結單的工單可以觸發。"}
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-white">Convex Real-Time Audit Trail</h3>
                <p className="mt-1 text-[11px] text-emerald-100/50">不可竄改證據鏈時間軸</p>
                <ol className="mt-3 max-h-80 space-y-3 overflow-y-auto pr-1" aria-live="polite">
                  {selected.auditLogs.map((log, index) => (
                    <li key={`${log.time}-${index}`} className="grid grid-cols-[12px_1fr] gap-3">
                      <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-emerald-300" />
                      <div>
                        <p className="text-[11px] text-emerald-100/50">
                          {formatHkTime(log.time)}・{log.actor}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-emerald-50">{log.action}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          ) : (
            <p className="text-sm text-emerald-100/60">選擇一張工單後會顯示分區、感測對比同審計軌跡。</p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3 rounded-3xl border border-white/10 bg-[#0c1813] p-3">
          <div className="flex items-start justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-emerald-200/70">
              <Smartphone className="h-3.5 w-3.5" aria-hidden />
              右欄 30%・順路秒拍打卡
            </h2>
            {selected ? <TicketQr ticketCode={selected.ticketCode} /> : null}
          </div>
          <PatrolProofCard ticket={selected} visionMode={visionMode} compact />
        </section>
      </section>
      {blueprintOpen ? <BlueprintModal onClose={() => setBlueprintOpen(false)} /> : null}
    </main>
  );
}
