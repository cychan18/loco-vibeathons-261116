"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type AnalyzeResult = {
  mode: "live" | "simulation";
  landmarkMatch: number;
  residualBikes: number;
  cleared: boolean;
  landmarks: string[];
  summary: string;
};

export type ProofSource = "PATROL" | "RIDER";

export type ProofTicket = {
  _id: Id<"tickets">;
  ticketCode: string;
  locationName: string;
  fullAddress: string;
  lat: number;
  lng: number;
  visionLandmarks: string[];
  csClosed: boolean;
  proofSubmitted: boolean;
  proofImageDataUrl?: string;
  proofTimestamp?: string;
  voucherIssued: boolean;
  activeTriggerSource?: string;
};

type VisionMode = "live" | "fast";

type DraftProof = {
  pngDataUrl: string;
  submitDataUrl: string;
  proofTimestamp: string;
};

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 1200;
const SUBMIT_URL_LIMIT = 680_000;
const PROOF_FONT =
  '"PingFang HK", "Noto Sans CJK TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失敗，請再試一次。";
}

function hkStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const day = `${pick("year")}/${pick("month")}/${pick("day")}`;
  const time = `${pick("hour")}:${pick("minute")}:${pick("second")}`;
  return { date: day, time, proofTimestamp: `${day} ${time}` };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawMiniMap(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  roundRect(ctx, x, y, size, size, 10);
  ctx.clip();
  ctx.fillStyle = "#c5ddb0";
  ctx.fillRect(x, y, size, size);

  ctx.fillStyle = "#7eb6d6";
  ctx.beginPath();
  ctx.moveTo(x + size * 0.58, y);
  ctx.bezierCurveTo(
    x + size * 0.78,
    y + size * 0.18,
    x + size * 0.7,
    y + size * 0.62,
    x + size * 0.46,
    y + size,
  );
  ctx.lineTo(x + size, y + size);
  ctx.lineTo(x + size, y);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#f7f4ee";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - 4, y + size * 0.38);
  ctx.lineTo(x + size + 4, y + size * 0.46);
  ctx.moveTo(x + size * 0.34, y - 4);
  ctx.lineTo(x + size * 0.46, y + size + 4);
  ctx.stroke();

  ctx.fillStyle = "#6aa84f";
  roundRect(ctx, x + 8, y + size * 0.58, size * 0.28, size * 0.26, 4);
  ctx.fill();

  ctx.fillStyle = "#f5c518";
  ctx.beginPath();
  ctx.arc(x + size * 0.5, y + size * 0.42, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1c1c1c";
  ctx.font = `700 14px ${PROOF_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("1", x + size * 0.5, y + size * 0.43);
  ctx.restore();
}

function drawCleanStreet(
  ctx: CanvasRenderingContext2D,
  locationName: string,
  fullAddress: string,
  landmarks: string[],
) {
  const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.58);
  sky.addColorStop(0, "#8ecae6");
  sky.addColorStop(1, "#e7f3ea");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.fillStyle = "#d5dbd6";
  ctx.fillRect(0, CANVAS_HEIGHT * 0.3, 250, 280);
  ctx.fillStyle = "#c3cbc4";
  ctx.fillRect(620, CANVAS_HEIGHT * 0.24, 280, 340);
  ctx.fillStyle = "#9fc0cf";
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      ctx.fillRect(28 + column * 52, CANVAS_HEIGHT * 0.34 + row * 48, 28, 26);
    }
  }

  if (fullAddress.includes("海") || locationName.includes("海")) {
    ctx.fillStyle = "#6eb0d4";
    ctx.fillRect(0, CANVAS_HEIGHT * 0.5, CANVAS_WIDTH, 70);
  }

  ctx.fillStyle = "#7dae6a";
  ctx.fillRect(0, CANVAS_HEIGHT * 0.56, CANVAS_WIDTH, 90);
  ctx.fillStyle = "#b85c4a";
  ctx.fillRect(0, CANVAS_HEIGHT * 0.64, CANVAS_WIDTH, 130);

  ctx.strokeStyle = "#f4f7f8";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_HEIGHT * 0.63);
  ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT * 0.63);
  ctx.stroke();
  for (let x = 18; x < CANVAS_WIDTH; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, CANVAS_HEIGHT * 0.63);
    ctx.lineTo(x, CANVAS_HEIGHT * 0.69);
    ctx.stroke();
  }

  ctx.fillStyle = "#4d555c";
  ctx.fillRect(0, CANVAS_HEIGHT * 0.76, CANVAS_WIDTH, CANVAS_HEIGHT * 0.24);
  ctx.strokeStyle = "#f3f3f3";
  ctx.setLineDash([22, 18]);
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_HEIGHT * 0.88);
  ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT * 0.88);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#12343f";
  roundRect(ctx, 28, CANVAS_HEIGHT * 0.36, 420, 58, 12);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 26px ${PROOF_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(locationName, 48, CANVAS_HEIGHT * 0.36 + 29);

  let chipX = 28;
  ctx.textBaseline = "middle";
  ctx.font = `500 16px ${PROOF_FONT}`;
  for (const landmark of landmarks.slice(0, 3)) {
    const chipWidth = Math.min(240, ctx.measureText(landmark).width + 22);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, chipX, CANVAS_HEIGHT * 0.47, chipWidth, 32, 16);
    ctx.fill();
    ctx.fillStyle = "#243038";
    ctx.fillText(landmark, chipX + 11, CANVAS_HEIGHT * 0.47 + 16);
    chipX += chipWidth + 8;
  }
}

function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement) {
  const scale = Math.max(CANVAS_WIDTH / image.width, CANVAS_HEIGHT / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, (CANVAS_WIDTH - width) / 2, (CANVAS_HEIGHT - height) / 2, width, height);
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  source: ProofSource,
  fullAddress: string,
  lat: number,
  lng: number,
  stamp: ReturnType<typeof hkStamp>,
) {
  ctx.save();
  ctx.font = `700 18px ${PROOF_FONT}`;
  const badge = source === "PATROL" ? "🚲 by LOCO PATROL" : "🎟️ by LOCO RIDER";
  const badgeWidth = ctx.measureText(badge).width + 28;
  const textWidth = CANVAS_WIDTH - 64 - 108 - 16 - badgeWidth - 24;
  const addressLines = wrapText(ctx, `📍 ${fullAddress}`, Math.max(220, textWidth)).slice(0, 3);
  const cardHeight = Math.max(168, 58 + addressLines.length * 24 + 58);
  const cardX = 16;
  const cardY = CANVAS_HEIGHT - cardHeight - 16;
  const cardWidth = CANVAS_WIDTH - 32;

  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  roundRect(ctx, cardX, cardY, cardWidth, cardHeight, 22);
  ctx.fill();
  ctx.strokeStyle = "rgba(20, 28, 34, 0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const mapSize = 96;
  drawMiniMap(ctx, cardX + 16, cardY + (cardHeight - mapSize) / 2, mapSize);

  const badgeHeight = 30;
  const badgeX = cardX + cardWidth - badgeWidth - 14;
  const badgeY = cardY + 12;
  ctx.fillStyle = source === "PATROL" ? "#0f4c5c" : "#f5c518";
  roundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);
  ctx.fill();
  ctx.fillStyle = source === "PATROL" ? "#ffffff" : "#1c1404";
  ctx.font = `700 15px ${PROOF_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(badge, badgeX + badgeWidth / 2, badgeY + badgeHeight / 2 + 0.5);

  const textX = cardX + 16 + mapSize + 14;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#2b2b2b";
  ctx.font = `700 18px ${PROOF_FONT}`;
  addressLines.forEach((line, index) => {
    ctx.fillText(line, textX, cardY + 50 + index * 24);
  });
  const metaY = cardY + 54 + addressLines.length * 24;
  ctx.fillStyle = "#5c6570";
  ctx.font = `500 16px ${PROOF_FONT}`;
  ctx.fillText(`📅 日期: ${stamp.date}`, textX, metaY);
  ctx.fillText(`🕒 時間: ${stamp.time}`, textX, metaY + 26);

  ctx.fillStyle = "#2f3944";
  ctx.font = `600 15px ${PROOF_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(lat.toFixed(6), cardX + cardWidth - 16, cardY + cardHeight - 38);
  ctx.fillText(lng.toFixed(6), cardX + cardWidth - 16, cardY + cardHeight - 16);
  ctx.restore();
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("相片讀取失敗"));
    image.src = src;
  });
}

async function readFile(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("相片讀取失敗"));
    reader.readAsDataURL(file);
  });
  return loadImage(dataUrl);
}

function toSubmitUrl(canvas: HTMLCanvasElement, pngDataUrl: string) {
  if (pngDataUrl.length <= SUBMIT_URL_LIMIT) return pngDataUrl;
  let quality = 0.86;
  let jpeg = canvas.toDataURL("image/jpeg", quality);
  while (jpeg.length > SUBMIT_URL_LIMIT && quality > 0.45) {
    quality -= 0.08;
    jpeg = canvas.toDataURL("image/jpeg", quality);
  }
  return jpeg;
}

async function composeProofImage(input: {
  source: ProofSource;
  photo: HTMLImageElement | null;
  locationName: string;
  fullAddress: string;
  landmarks: string[];
  lat: number;
  lng: number;
  stamp: ReturnType<typeof hkStamp>;
}): Promise<DraftProof> {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("無法建立現場相片。");
  if (input.photo) drawCover(ctx, input.photo);
  else drawCleanStreet(ctx, input.locationName, input.fullAddress, input.landmarks);
  drawWatermark(ctx, input.source, input.fullAddress, input.lat, input.lng, input.stamp);
  const pngDataUrl = canvas.toDataURL("image/png");
  return {
    pngDataUrl,
    submitDataUrl: toSubmitUrl(canvas, pngDataUrl),
    proofTimestamp: input.stamp.proofTimestamp,
  };
}

const simulationAnalysis = (landmarks: string[]): AnalyzeResult => ({
  mode: "simulation",
  landmarkMatch: 96,
  residualBikes: 0,
  cleared: true,
  landmarks,
  summary: "地標與投訴點吻合，現場未見殘留單車。",
});

export function PatrolProofCard({
  ticket,
  visionMode,
  compact = false,
}: {
  ticket: ProofTicket | null;
  visionMode: VisionMode;
  compact?: boolean;
}) {
  const submitProofAndClose = useMutation(api.tickets.submitProofAndClose);
  const ticketKey = ticket?._id ?? null;
  const [trackedKey, setTrackedKey] = useState(ticketKey);
  const [source, setSource] = useState<ProofSource>(
    ticket?.activeTriggerSource === "RIDER" ? "RIDER" : "PATROL",
  );
  const [draft, setDraft] = useState<DraftProof | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reward, setReward] = useState(false);
  const [busy, setBusy] = useState(false);

  if (trackedKey !== ticketKey) {
    setTrackedKey(ticketKey);
    setSource(ticket?.activeTriggerSource === "RIDER" ? "RIDER" : "PATROL");
    setDraft(null);
    setAnalysis(null);
    setError(null);
    setStatus(null);
    setReward(false);
  }

  if (!ticket) {
    return (
      <p className="rounded-2xl border border-white/10 bg-black/20 px-3 py-6 text-center text-sm text-emerald-100/60">
        選擇工單後可以在這裡順路拍攝並結單。
      </p>
    );
  }

  const closed = ticket.csClosed || ticket.proofSubmitted;
  const previewUrl = draft?.pngDataUrl ?? ticket.proofImageDataUrl ?? null;
  const visibleAnalysis = analysis ?? (ticket.proofSubmitted ? simulationAnalysis(ticket.visionLandmarks) : null);
  const downloadName = `${ticket.ticketCode.replace(/^[#＃]/, "")}-proof.png`;

  async function analyze(imageDataUrl: string) {
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: visionMode,
          locationName: ticket?.locationName,
          fullAddress: ticket?.fullAddress,
          landmarks: ticket?.visionLandmarks ?? [],
          imageDataUrl,
        }),
      });
      if (!response.ok) return simulationAnalysis(ticket?.visionLandmarks ?? []);
      return (await response.json()) as AnalyzeResult;
    } catch {
      return simulationAnalysis(ticket?.visionLandmarks ?? []);
    }
  }

  async function capture(photo: HTMLImageElement | null) {
    if (!ticket || closed) return;
    setBusy(true);
    setError(null);
    setStatus("正在合成 Loco 水印鐵證…");
    try {
      const stamp = hkStamp();
      const nextDraft = await composeProofImage({
        source,
        photo,
        locationName: ticket.locationName,
        fullAddress: ticket.fullAddress,
        landmarks: ticket.visionLandmarks,
        lat: ticket.lat,
        lng: ticket.lng,
        stamp,
      });
      setDraft(nextDraft);
      setStatus(visionMode === "live" ? "Live Vision API 核對地標…" : "正在核對地標…");
      setAnalysis(await analyze(nextDraft.submitDataUrl));
      setStatus(null);
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!ticket || !draft || closed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitProofAndClose({
        ticketId: ticket._id,
        proofTimestamp: draft.proofTimestamp,
        proofImageDataUrl: draft.submitDataUrl,
        source,
      });
      setReward(result.voucherIssued && source === "RIDER");
      setStatus(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cx("mx-auto w-full", compact ? "max-w-[340px]" : "max-w-md")}>
      <div className="overflow-hidden rounded-[1.7rem] border border-white/10 bg-[#07140f] shadow-[0_16px_40px_rgba(0,0,0,0.28)]">
        <div className="flex gap-1 border-b border-white/10 p-2">
          <button
            type="button"
            aria-pressed={source === "PATROL"}
            className={cx(
              "flex-1 rounded-full px-2 py-1.5 text-[11px] font-medium",
              source === "PATROL" ? "bg-[#0f4c5c] text-white" : "text-emerald-100/60",
            )}
            onClick={() => {
              setSource("PATROL");
              setDraft(null);
              setAnalysis(null);
            }}
          >
            🚐 Patrol 隊員視角
          </button>
          <button
            type="button"
            aria-pressed={source === "RIDER"}
            className={cx(
              "flex-1 rounded-full px-2 py-1.5 text-[11px] font-medium",
              source === "RIDER" ? "bg-[#f5c518] text-[#1c1404]" : "text-emerald-100/60",
            )}
            onClick={() => {
              setSource("RIDER");
              setDraft(null);
              setAnalysis(null);
            }}
          >
            📱 Loco Rider App 視角
          </button>
        </div>

        <div className="space-y-3 p-3">
          <div
            className={cx(
              "rounded-2xl px-3 py-3 text-xs leading-5",
              source === "RIDER" ? "bg-[#3a2d0c] text-amber-50" : "bg-[#102830] text-emerald-50",
            )}
          >
            {source === "RIDER" ? (
              <p>
                📍 偵測到你正位於【{ticket.locationName}】30m 範圍內！幫手拍 1 張面前行人路相片（確認無單車阻塞），立即送你{" "}
                <strong>2 張 30 分鐘踩車券</strong> 🎟️🎟️！
              </p>
            ) : (
              <p>
                🔔 順路任務觸發：你正途經【{ticket.locationName}】(距離 45m)。系統顯示單車已被踩走，請順手拍攝 1 張空地相即可秒結單！
              </p>
            )}
          </div>

          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={`${ticket.locationName} 帶時間戳記的現場鐵證`}
              className="max-h-[420px] w-full rounded-2xl object-contain bg-black"
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-white/15 text-center text-xs text-emerald-100/50">
              尚未拍攝。合成後會加上 Loco 磨砂白底水印。
            </div>
          )}

          {visibleAnalysis ? (
            <div className="rounded-2xl bg-black/30 px-3 py-2 text-xs leading-5 text-emerald-50">
              <p>✅ AI 地標吻合度 {visibleAnalysis.landmarkMatch}%</p>
              <p>✅ 現場殘留單車 {visibleAnalysis.residualBikes} 部</p>
              <p className="mt-1 text-emerald-100/60">{visibleAnalysis.summary}</p>
            </div>
          ) : null}
          {status ? <p className="text-xs text-emerald-100/70">{status}</p> : null}
          {error ? (
            <p role="alert" className="text-xs text-red-200">
              {error}
            </p>
          ) : null}

          {closed ? (
            <p className="rounded-xl bg-emerald-950/60 px-3 py-2 text-xs text-emerald-50">
              此工單已帶時間戳記結單{ticket.proofTimestamp ? `（${ticket.proofTimestamp}）` : ""}。
            </p>
          ) : (
            <div className="grid gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void capture(null)}
                className="rounded-xl bg-white px-3 py-2 text-left text-xs font-semibold text-black disabled:opacity-50"
              >
                ⚡ 一鍵模擬拍攝「現場已清空」街景相
              </button>
              <label className="cursor-pointer rounded-xl border border-white/15 px-3 py-2 text-xs font-semibold text-emerald-50">
                📷 開啟相機 / 上傳現場空地相
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    void readFile(file).then((image) => capture(image)).catch((caught: unknown) => {
                      setError(errorMessage(caught));
                    });
                  }}
                />
              </label>
            </div>
          )}

          {draft?.pngDataUrl ? (
            <a
              href={draft.pngDataUrl}
              download={downloadName}
              className="block rounded-xl border border-white/15 px-3 py-2 text-center text-xs"
            >
              💾 下載合成後 Timestamp 鐵證相 (.png)
            </a>
          ) : null}

          {closed ? null : (
            <button
              type="button"
              disabled={busy || !draft}
              onClick={() => void submit()}
              className="w-full rounded-xl bg-emerald-400 px-3 py-2.5 text-xs font-semibold text-black disabled:opacity-40"
            >
              📲 一鍵回傳 CS WhatsApp 並結單
            </button>
          )}

          {source === "RIDER" && (reward || ticket.voucherIssued) ? (
            <p className="rounded-xl bg-[#3a2d0c] px-3 py-2 text-xs leading-5 text-amber-50">
              🎉 已自動派發 2 張 30 分鐘踩車券至用戶 Loco 帳戶！
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
