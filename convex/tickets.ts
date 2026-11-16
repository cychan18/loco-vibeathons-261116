import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

const TICKET_CODE_PREFIX = "#LOCO-";
const TICKET_CODE_FLOOR = 800;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const GPS_TRUST_MAX_METERS = 15;
const GPS_DRIFT_REJECT_METERS = 30;
const VOUCHERS_PER_RIDER_PROOF = 2;
const PATROL_GEOFENCE_METERS = 50;
const RIDER_GEOFENCE_METERS = 30;
const MAX_PROOF_DATA_URL_CHARS = 700_000;

const captureSourceValidator = v.union(v.literal("PATROL"), v.literal("RIDER"));

type CaptureSource = "PATROL" | "RIDER";

type TriageDecision =
  | "OPPORTUNISTIC_POOL"
  | "URGENT_DISPATCH"
  | "LOW_CONFIDENCE_VERIFY"
  | "MERGED_DUPLICATE";

type TicketInsert = {
  ticketCode: string;
  scenarioKey: string;
  geoZone: string;
  locationName: string;
  fullAddress: string;
  lat: number;
  lng: number;
  citizenMessage: string;
  reportedAt: string;
  visionBikeCount: number;
  visionObstacleLevel: string;
  visionLandmarks: string[];
  iotLockedBikes: number;
  iotUnlockedRecently: number;
  gpsErrorMeters: number;
  confidenceScore: number;
  triageDecision: string;
  triageReason: string;
  proofSubmitted: boolean;
  voucherIssued: boolean;
  csClosed: boolean;
  auditLogs: Array<{ time: string; actor: string; action: string }>;
};

type TriageOutcome = {
  triageDecision: TriageDecision;
  confidenceScore: number;
  triageReason: string;
  mergedIntoCode?: string;
  parentId?: Doc<"tickets">["_id"];
  parentNote?: string;
};

const CASE_A_REPORTED_AT = "2026-11-16T08:12:04+08:00";
const CASE_D_REPORTED_AT = "2026-11-16T08:15:04+08:00";

const PENDING_REASON =
  "待分流：已完成入線與 Auto-Zone 分區，尚未執行 AI Triage。";

function nowIsoHk(date = new Date()): string {
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
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}+08:00`;
}

function clampScore(score: number): number {
  return Math.max(1, Math.min(99, Math.round(score)));
}

function normalizeTicketCode(ticketCode: string): string {
  return ticketCode.trim().replace(/^[#＃]/, "").toUpperCase();
}

function normalizeLocationName(locationName: string): string {
  return locationName.trim().replace(/\s+/g, " ").toLowerCase();
}

function nextTicketCode(tickets: Array<{ ticketCode: string }>): string {
  let max = TICKET_CODE_FLOOR;
  for (const ticket of tickets) {
    const match = /LOCO-(\d+)/i.exec(ticket.ticketCode);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `${TICKET_CODE_PREFIX}${max + 1}`;
}

function representativePoint(geoZone: string, locationName: string): {
  lat: number;
  lng: number;
  fullAddress: string;
} {
  if (geoZone.includes("將軍澳")) {
    return {
      lat: 22.303421,
      lng: 114.259874,
      fullAddress: `${locationName}, 將軍澳, 西貢區, 新界, 中國香港特別行政區`,
    };
  }
  if (geoZone.includes("沙田") || geoZone.includes("大圍")) {
    return {
      lat: 22.372615,
      lng: 114.178642,
      fullAddress: `${locationName}, 沙田區, 新界, 中國香港特別行政區`,
    };
  }
  if (geoZone.includes("觀塘")) {
    return {
      lat: 22.312218,
      lng: 114.225812,
      fullAddress: `${locationName}, 觀塘區, 九龍, 中國香港特別行政區`,
    };
  }
  return {
    lat: 22.281901,
    lng: 114.158127,
    fullAddress: `${locationName}, ${geoZone}, 中國香港特別行政區`,
  };
}

function buildPendingTicket(
  input: Omit<
    TicketInsert,
    | "confidenceScore"
    | "triageDecision"
    | "triageReason"
    | "proofSubmitted"
    | "voucherIssued"
    | "csClosed"
    | "auditLogs"
  >,
  intake: { actor: string; action: string },
): TicketInsert {
  return {
    ...input,
    confidenceScore: 0,
    triageDecision: "PENDING",
    triageReason: PENDING_REASON,
    proofSubmitted: false,
    voucherIssued: false,
    csClosed: false,
    auditLogs: [
      {
        time: input.reportedAt,
        actor: intake.actor,
        action: intake.action,
      },
      {
        time: input.reportedAt,
        actor: "Auto-Zone Router",
        action: `已按座標 (${input.lat.toFixed(6)}, ${input.lng.toFixed(6)}) 自動分區路由至「${input.geoZone}」。`,
      },
    ],
  };
}

function findMergeParent(
  ticket: Doc<"tickets">,
  allTickets: Doc<"tickets">[],
): { parent: Doc<"tickets">; minutesApart: number } | null {
  const reportedAt = Date.parse(ticket.reportedAt);
  const locationName = normalizeLocationName(ticket.locationName);
  if (Number.isNaN(reportedAt) || locationName.length === 0) return null;

  const candidates = allTickets.filter((other) => {
    if (other._id === ticket._id) return false;
    if (normalizeLocationName(other.locationName) !== locationName) return false;
    const otherReportedAt = Date.parse(other.reportedAt);
    if (Number.isNaN(otherReportedAt)) return false;
    const delta = reportedAt - otherReportedAt;
    return delta > 0 && delta <= DUPLICATE_WINDOW_MS;
  });

  candidates.sort(
    (left, right) => Date.parse(left.reportedAt) - Date.parse(right.reportedAt),
  );
  const earliest = candidates[0];
  if (!earliest) return null;

  const minutesApart = Math.max(
    1,
    Math.round((reportedAt - Date.parse(earliest.reportedAt)) / 60000),
  );

  if (
    earliest.triageDecision === "MERGED_DUPLICATE" &&
    earliest.mergedIntoCode
  ) {
    const root = allTickets.find(
      (candidate) => candidate.ticketCode === earliest.mergedIntoCode,
    );
    if (root && root._id !== ticket._id) {
      return { parent: root, minutesApart };
    }
  }

  return { parent: earliest, minutesApart };
}

/**
 * 分流順序：
 * 1. 同地點 10 分鐘內的較早工單 → MERGED_DUPLICATE（CASE_D 併入 CASE_A）
 * 2. GPS 漂移 ≥ 30m → LOW_CONFIDENCE_VERIFY（CASE_C 防誤判，不因 IoT 0 部就當清空）
 * 3. Vision 0 且 IoT 鎖定 0，且 GPS ≤ 15m → OPPORTUNISTIC_POOL（CASE_A 已被踩走）
 * 4. Vision 與 IoT 都見到車且數量吻合，GPS ≤ 15m → URGENT_DISPATCH（CASE_B 死車阻塞）
 * 5. 其餘信號互相矛盾 → LOW_CONFIDENCE_VERIFY
 */
function decideTriage(
  ticket: Doc<"tickets">,
  allTickets: Doc<"tickets">[],
): TriageOutcome {
  const duplicate = findMergeParent(ticket, allTickets);
  if (duplicate) {
    const { parent, minutesApart } = duplicate;
    const triageReason = `與 ${parent.ticketCode} 同為「${ticket.locationName}」，投訴相隔 ${minutesApart} 分鐘，判定重複工單。已合併至 ${parent.ticketCode}，避免二次出勤，並沿用「${ticket.geoZone}」原分區路由。`;
    return {
      triageDecision: "MERGED_DUPLICATE",
      confidenceScore: 96,
      triageReason,
      mergedIntoCode: parent.ticketCode,
      parentId: parent._id,
      parentNote: `重複投訴 ${ticket.ticketCode} 已合併入本單，避免對「${ticket.locationName}」二次出勤。`,
    };
  }

  const { visionBikeCount, iotLockedBikes, iotUnlockedRecently, gpsErrorMeters } =
    ticket;

  if (gpsErrorMeters >= GPS_DRIFT_REJECT_METERS) {
    const confidenceScore = clampScore(
      70 - Math.round((gpsErrorMeters - GPS_DRIFT_REJECT_METERS) * 0.8),
    );
    return {
      triageDecision: "LOW_CONFIDENCE_VERIFY",
      confidenceScore,
      triageReason: `GPS 漂移達 ±${gpsErrorMeters}m，後台 IoT 顯示 ${iotLockedBikes} 部、Vision 顯示 ${visionBikeCount} 部，不足以確認現場已清空。防誤判保護生效，暫不放入順路池，已自動路由至「${ticket.geoZone}」分區群組待覆核。`,
    };
  }

  const confirmedEmpty =
    visionBikeCount === 0 &&
    iotLockedBikes === 0 &&
    gpsErrorMeters <= GPS_TRUST_MAX_METERS;

  if (confirmedEmpty) {
    const confidenceScore = clampScore(
      90 + Math.min(iotUnlockedRecently, 8) - Math.round(gpsErrorMeters * 0.5),
    );
    return {
      triageDecision: "OPPORTUNISTIC_POOL",
      confidenceScore,
      triageReason: `Vision 現場 ${visionBikeCount} 部、IoT 鎖定 ${iotLockedBikes} 部、近時段解鎖 ${iotUnlockedRecently} 部，GPS 誤差 ±${gpsErrorMeters}m。系統確認單車已被踩走、現場已清空，免除專程派車，已自動路由至「${ticket.geoZone}」雙軌順路補拍池。`,
    };
  }

  const countsAgree = Math.abs(visionBikeCount - iotLockedBikes) <= 1;
  const confirmedOccupied =
    visionBikeCount > 0 &&
    iotLockedBikes > 0 &&
    countsAgree &&
    gpsErrorMeters <= GPS_TRUST_MAX_METERS;

  if (confirmedOccupied) {
    const confidenceScore = clampScore(
      90 + (visionBikeCount === iotLockedBikes ? 5 : 0) - Math.round(gpsErrorMeters * 0.5),
    );
    return {
      triageDecision: "URGENT_DISPATCH",
      confidenceScore,
      triageReason: `Vision 現場 ${visionBikeCount} 部、IoT 鎖定 ${iotLockedBikes} 部，障礙程度 ${ticket.visionObstacleLevel}，GPS 誤差 ±${gpsErrorMeters}m。單車仍在場，已自動路由至「${ticket.geoZone}」分區群組並安排緊急出勤。`,
    };
  }

  const confidenceScore = clampScore(
    64 - Math.abs(visionBikeCount - iotLockedBikes) * 4 - Math.round(gpsErrorMeters * 0.2),
  );
  return {
    triageDecision: "LOW_CONFIDENCE_VERIFY",
    confidenceScore,
    triageReason: `Vision（${visionBikeCount} 部）與 IoT 鎖定（${iotLockedBikes} 部）不一致，GPS 誤差 ±${gpsErrorMeters}m。信心不足，已自動路由至「${ticket.geoZone}」分區群組待覆核，避免錯誤免除出勤。`,
  };
}

function summarizeStats(tickets: Doc<"tickets">[]) {
  const ineffectiveTripsSaved = tickets.filter(
    (ticket) =>
      ticket.triageDecision === "OPPORTUNISTIC_POOL" ||
      ticket.triageDecision === "MERGED_DUPLICATE",
  ).length;
  const opportunisticPoolPending = tickets.filter(
    (ticket) =>
      ticket.triageDecision === "OPPORTUNISTIC_POOL" && !ticket.csClosed,
  ).length;
  const riderVouchersIssued =
    tickets.filter((ticket) => ticket.voucherIssued).length * VOUCHERS_PER_RIDER_PROOF;
  const closedTickets = tickets.filter((ticket) => ticket.csClosed);
  const compliantClosed = closedTickets.filter(
    (ticket) => ticket.proofSubmitted && Boolean(ticket.proofTimestamp),
  ).length;
  const csComplianceRate =
    closedTickets.length === 0
      ? 100
      : Math.round((compliantClosed / closedTickets.length) * 100);

  return {
    ineffectiveTripsSaved,
    opportunisticPoolPending,
    riderVouchersIssued,
    csComplianceRate,
  };
}

const INITIAL_CASES: TicketInsert[] = [
  buildPendingTicket(
    {
      ticketCode: "#LOCO-801",
      scenarioKey: "CASE_A",
      geoZone: "新界東｜沙田・大圍區",
      locationName: "大圍站 A 出口",
      fullAddress: "大圍站 A 出口行人路, 沙田區, 新界, 中國香港特別行政區",
      lat: 22.372615,
      lng: 114.178642,
      citizenMessage:
        "大圍站 A 出口行人路有成排 Loco 單車霸住條路，差啲撞到出閘的人，麻煩即刻派人嚟處理。",
      reportedAt: CASE_A_REPORTED_AT,
      visionBikeCount: 0,
      visionObstacleLevel: "CLEAR",
      visionLandmarks: ["#港鐵站出口", "#白色欄杆", "#紅磚行人路"],
      iotLockedBikes: 0,
      iotUnlockedRecently: 6,
      gpsErrorMeters: 8,
    },
    {
      actor: "WhatsApp Intake",
      action: "市民 WhatsApp 投訴已入線。Vision／IoT 顯示 6 部單車已被踩走，現場目前 0 部，GPS 誤差 ±8m。",
    },
  ),
  buildPendingTicket(
    {
      ticketCode: "#LOCO-802",
      scenarioKey: "CASE_B",
      geoZone: "九龍東｜將軍澳區",
      locationName: "將軍澳海濱長廊",
      fullAddress: "將軍澳海濱長廊, 將軍澳, 西貢區, 新界, 中國香港特別行政區",
      lat: 22.303421,
      lng: 114.259874,
      citizenMessage:
        "將軍澳海濱長廊有 8 架死車鎖死喺度，塞住成條長廊，嬰兒車過唔到，麻煩快啲嚟清。",
      reportedAt: "2026-11-16T08:27:41+08:00",
      visionBikeCount: 8,
      visionObstacleLevel: "BLOCKING",
      visionLandmarks: ["#海濱長廊", "#紅色欄杆", "#海景行人路"],
      iotLockedBikes: 8,
      iotUnlockedRecently: 0,
      gpsErrorMeters: 6,
    },
    {
      actor: "WhatsApp Intake",
      action: "市民 WhatsApp 投訴已入線。Vision 與 IoT 都確認 8 部死車仍在場阻塞，GPS 誤差 ±6m。",
    },
  ),
  buildPendingTicket(
    {
      ticketCode: "#LOCO-803",
      scenarioKey: "CASE_C",
      geoZone: "新界東｜沙田・大圍區",
      locationName: "沙田圍天橋底",
      fullAddress: "沙田圍天橋底, 沙田區, 新界, 中國香港特別行政區",
      lat: 22.376982,
      lng: 114.195214,
      citizenMessage:
        "沙田圍天橋底好似有 4 架單車丟低，不過我個定位飄得好厲害，怕報錯位，唔好當冇車就收檔。",
      reportedAt: "2026-11-16T08:41:18+08:00",
      visionBikeCount: 4,
      visionObstacleLevel: "UNCERTAIN",
      visionLandmarks: ["#行人天橋", "#混凝土橋底", "#單車徑"],
      iotLockedBikes: 0,
      iotUnlockedRecently: 0,
      gpsErrorMeters: 45,
    },
    {
      actor: "WhatsApp Intake",
      action: "市民 WhatsApp 投訴已入線。投訴約 4 部車，後台 IoT 在座標上是 0 部，但 GPS 漂移達 ±45m。",
    },
  ),
  buildPendingTicket(
    {
      ticketCode: "#LOCO-804",
      scenarioKey: "CASE_D",
      geoZone: "新界東｜沙田・大圍區",
      locationName: "大圍站 A 出口",
      fullAddress: "大圍站 A 出口行人路, 沙田區, 新界, 中國香港特別行政區",
      lat: 22.372615,
      lng: 114.178642,
      citizenMessage:
        "大圍站 A 出口又有單車阻住出閘，3 分鐘前先有人投訴過，應該係同一單，唔好派多隊。",
      reportedAt: CASE_D_REPORTED_AT,
      visionBikeCount: 0,
      visionObstacleLevel: "CLEAR",
      visionLandmarks: ["#港鐵站出口", "#白色欄杆", "#紅磚行人路"],
      iotLockedBikes: 0,
      iotUnlockedRecently: 6,
      gpsErrorMeters: 8,
    },
    {
      actor: "WhatsApp Intake",
      action: "市民 WhatsApp 重複投訴已入線。地點與 #LOCO-801 相同，相隔 3 分鐘。",
    },
  ),
];

export const getAllTickets = query({
  args: {},
  handler: async (ctx) => {
    const tickets = await ctx.db.query("tickets").collect();
    tickets.sort((left, right) => {
      const byTime = Date.parse(right.reportedAt) - Date.parse(left.reportedAt);
      if (byTime !== 0) return byTime;
      return right.ticketCode.localeCompare(left.ticketCode);
    });
    return {
      tickets,
      stats: summarizeStats(tickets),
    };
  },
});

export const getTicketByCode = query({
  args: { ticketCode: v.string() },
  handler: async (ctx, args) => {
    const trimmed = args.ticketCode.trim();
    const bare = trimmed.replace(/^[#＃]/, "");
    const variants = [...new Set([trimmed, bare, `#${bare}`])];

    for (const variant of variants) {
      const found = await ctx.db
        .query("tickets")
        .withIndex("by_ticketCode", (q) => q.eq("ticketCode", variant))
        .unique();
      if (found) return found;
    }

    const normalized = normalizeTicketCode(trimmed);
    if (!normalized) return null;
    const tickets = await ctx.db.query("tickets").collect();
    return (
      tickets.find((ticket) => normalizeTicketCode(ticket.ticketCode) === normalized) ??
      null
    );
  },
});

export const seedInitialCases = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("tickets").collect();
    for (const ticket of existing) {
      await ctx.db.delete(ticket._id);
    }

    const ticketCodes: string[] = [];
    for (const ticket of INITIAL_CASES) {
      await ctx.db.insert("tickets", ticket);
      ticketCodes.push(ticket.ticketCode);
    }

    return {
      reset: true,
      count: ticketCodes.length,
      ticketCodes,
    };
  },
});

export const createCustomTicket = mutation({
  args: {
    locationName: v.string(),
    geoZone: v.string(),
    citizenMessage: v.string(),
    simulatedEmpty: v.boolean(),
  },
  handler: async (ctx, args) => {
    const locationName = args.locationName.trim();
    const geoZone = args.geoZone.trim();
    const citizenMessage = args.citizenMessage.trim();
    if (!locationName || !geoZone || !citizenMessage) {
      throw new Error("地點、分區與投訴內容都必須填寫。");
    }

    const existing = await ctx.db.query("tickets").collect();
    const ticketCode = nextTicketCode(existing);
    const point = representativePoint(geoZone, locationName);
    const reportedAt = nowIsoHk();
    const site = args.simulatedEmpty
      ? {
          visionBikeCount: 0,
          visionObstacleLevel: "CLEAR",
          visionLandmarks: ["#自訂投訴點", "#現場環境"],
          iotLockedBikes: 0,
          iotUnlockedRecently: 3,
          gpsErrorMeters: 8,
        }
      : {
          visionBikeCount: 3,
          visionObstacleLevel: "MODERATE",
          visionLandmarks: ["#自訂投訴點", "#違泊單車"],
          iotLockedBikes: 3,
          iotUnlockedRecently: 0,
          gpsErrorMeters: 7,
        };

    const ticketId = await ctx.db.insert(
      "tickets",
      buildPendingTicket(
        {
          ticketCode,
          scenarioKey: "CUSTOM",
          geoZone,
          locationName,
          fullAddress: point.fullAddress,
          lat: point.lat,
          lng: point.lng,
          citizenMessage,
          reportedAt,
          ...site,
        },
        {
          actor: "CS Agent",
          action: `已建立自訂投訴「${locationName}」（模擬現場${args.simulatedEmpty ? "已清空" : "仍有單車"}）。`,
        },
      ),
    );

    return { ticketId, ticketCode };
  },
});

export const runAiTriage = mutation({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("找不到工單。");
    if (ticket.csClosed) throw new Error("此工單已結單，不能再分流。");

    const allTickets = await ctx.db.query("tickets").collect();
    const outcome = decideTriage(ticket, allTickets);
    const auditedAt = nowIsoHk();

    await ctx.db.patch(ticket._id, {
      triageDecision: outcome.triageDecision,
      confidenceScore: outcome.confidenceScore,
      triageReason: outcome.triageReason,
      mergedIntoCode: outcome.mergedIntoCode,
      auditLogs: [
        ...ticket.auditLogs,
        {
          time: auditedAt,
          actor: "AI Triage Engine",
          action: `分流結果：${outcome.triageDecision}（信心 ${outcome.confidenceScore}）。${outcome.triageReason}`,
        },
      ],
    });

    if (outcome.parentId && outcome.parentNote) {
      const parent = allTickets.find((candidate) => candidate._id === outcome.parentId);
      const alreadyNoted = parent?.auditLogs.some((log) =>
        log.action.includes(ticket.ticketCode),
      );
      if (parent && !alreadyNoted) {
        await ctx.db.patch(parent._id, {
          auditLogs: [
            ...parent.auditLogs,
            {
              time: auditedAt,
              actor: "AI Triage Engine",
              action: outcome.parentNote,
            },
          ],
        });
      }
    }

    return {
      ticketId: ticket._id,
      ticketCode: ticket.ticketCode,
      triageDecision: outcome.triageDecision,
      confidenceScore: outcome.confidenceScore,
      triageReason: outcome.triageReason,
      mergedIntoCode: outcome.mergedIntoCode ?? null,
    };
  },
});

export const triggerOpportunisticCapture = mutation({
  args: {
    ticketId: v.id("tickets"),
    source: captureSourceValidator,
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("找不到工單。");
    if (ticket.csClosed) throw new Error("此工單已結單，不能再觸發補拍。");
    if (ticket.triageDecision !== "OPPORTUNISTIC_POOL") {
      throw new Error(
        "只有「系統確認已清空」並進入雙軌順路補拍池的工單，先可以順路補拍。請先執行 AI 分流。",
      );
    }

    const triggeredAt = nowIsoHk();
    const action =
      args.source === "PATROL"
        ? `Patrol 隊員於換電／調度途中進入投訴點 ${PATROL_GEOFENCE_METERS}m 圍欄，已掛載軌跡 A 順路補拍，水印標記 🚲 by LOCO PATROL。`
        : `Loco App 偵測到 Rider 在投訴點 ${RIDER_GEOFENCE_METERS}m 內開啟 App（Current Location），已推送軌跡 B 現場環境拍攝任務。`;

    await ctx.db.patch(ticket._id, {
      activeTriggerSource: args.source,
      auditLogs: [
        ...ticket.auditLogs,
        {
          time: triggeredAt,
          actor: args.source === "PATROL" ? "LOCO PATROL" : "Loco App",
          action,
        },
      ],
    });

    return {
      ticketId: ticket._id,
      ticketCode: ticket.ticketCode,
      activeTriggerSource: args.source as CaptureSource,
    };
  },
});

export const submitProofAndClose = mutation({
  args: {
    ticketId: v.id("tickets"),
    proofTimestamp: v.string(),
    proofImageDataUrl: v.string(),
    source: captureSourceValidator,
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("找不到工單。");
    if (ticket.csClosed || ticket.proofSubmitted) {
      throw new Error("此工單已提交現場證據並結單，不能重複提交。");
    }

    const proofTimestamp = args.proofTimestamp.trim();
    const proofImageDataUrl = args.proofImageDataUrl.trim();
    if (!proofTimestamp) {
      throw new Error("現場相片必須附有時間戳記，否則不能結單。");
    }
    if (!proofImageDataUrl.startsWith("data:image/")) {
      throw new Error("現場相片必須為 data URL 圖片，CS 證據鏈未完成。");
    }
    if (proofImageDataUrl.length > MAX_PROOF_DATA_URL_CHARS) {
      throw new Error("現場相片過大，請壓縮至約 700KB 以內再上傳。");
    }

    const closedAt = nowIsoHk();
    const source = args.source as CaptureSource;
    const watermark = source === "PATROL" ? "🚲 by LOCO PATROL" : "🎟️ by LOCO RIDER";
    const voucherIssued = source === "RIDER" ? true : ticket.voucherIssued;
    const auditLogs = [
      ...ticket.auditLogs,
      {
        time: proofTimestamp,
        actor: source === "PATROL" ? "LOCO PATROL" : "LOCO RIDER",
        action: `已提交帶時間戳記的現場相片（${proofTimestamp}），水印 ${watermark}。`,
      },
    ];

    if (source === "RIDER") {
      auditLogs.push({
        time: closedAt,
        actor: "Reward Engine",
        action: "🎟️ Reward Engine: 已自動派發 2 張 30 分鐘踩車券予協助用戶",
      });
    }

    auditLogs.push({
      time: closedAt,
      actor: "CS WhatsApp Auto-Reply",
      action:
        "已附上時間戳記現場相片，強制證據鏈閉環，自動回覆市民並完成結單。",
    });

    await ctx.db.patch(ticket._id, {
      activeTriggerSource: source,
      proofSubmitted: true,
      proofTimestamp,
      proofImageDataUrl,
      voucherIssued,
      csClosed: true,
      auditLogs,
    });

    return {
      ticketId: ticket._id,
      ticketCode: ticket.ticketCode,
      proofSubmitted: true,
      csClosed: true,
      voucherIssued,
      vouchersIssuedNow: source === "RIDER" ? VOUCHERS_PER_RIDER_PROOF : 0,
    };
  },
});
