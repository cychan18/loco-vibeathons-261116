import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Loco Vibeathons — 減少共享單車巡邏隊的無效現場出勤。
 *
 * 字串欄位的允許值（以 v.string() 儲存，由 mutations 負責約束）：
 * - scenarioKey: "CASE_A" | "CASE_B" | "CASE_C" | "CASE_D" | "CASE_E" | "CUSTOM"
 * - triageDecision: "PENDING" | "OPPORTUNISTIC_POOL" | "URGENT_DISPATCH" | "LOW_CONFIDENCE_VERIFY" | "MERGED_DUPLICATE"
 * - activeTriggerSource: "PATROL" | "RIDER"
 */
export const auditLogValidator = v.object({
  time: v.string(),
  actor: v.string(),
  action: v.string(),
});

export default defineSchema({
  tickets: defineTable({
    ticketCode: v.string(),
    scenarioKey: v.string(),
    geoZone: v.string(),
    locationName: v.string(),
    fullAddress: v.string(),
    lat: v.number(),
    lng: v.number(),
    citizenMessage: v.string(),
    reportedAt: v.string(),
    visionBikeCount: v.number(),
    visionObstacleLevel: v.string(),
    visionLandmarks: v.array(v.string()),
    iotLockedBikes: v.number(),
    iotUnlockedRecently: v.number(),
    gpsErrorMeters: v.number(),
    confidenceScore: v.number(),
    triageDecision: v.string(),
    triageReason: v.string(),
    mergedIntoCode: v.optional(v.string()),
    activeTriggerSource: v.optional(v.string()),
    proofSubmitted: v.boolean(),
    proofTimestamp: v.optional(v.string()),
    proofImageDataUrl: v.optional(v.string()),
    voucherIssued: v.boolean(),
    csClosed: v.boolean(),
    auditLogs: v.array(auditLogValidator),
  }).index("by_ticketCode", ["ticketCode"]),
});
