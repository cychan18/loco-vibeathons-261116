import { NextResponse } from "next/server";

export type AnalyzeMode = "live" | "simulation";
export type AnalyzeCompliance = "CLEARED" | "YELLOW_ZONE" | "BLOCKED";
export type SuggestedTriage = "OPPORTUNISTIC_POOL" | "URGENT_DISPATCH" | "LOW_CONFIDENCE_VERIFY";

export type AnalyzeResult = {
  mode: AnalyzeMode;
  landmarkMatch: number;
  residualBikes: number;
  cleared: boolean;
  organizedInYellowZone: boolean;
  yellowZoneStatus: "ORGANIZED" | "NOT_APPLICABLE" | "STILL_BLOCKING";
  compliance: AnalyzeCompliance;
  suggestedTriage: SuggestedTriage;
  landmarks: string[];
  summary: string;
  csReply?: string;
};

type AnalyzeBody = {
  mode?: string;
  captureKind?: string;
  locationName?: string;
  fullAddress?: string;
  landmarks?: unknown;
  imageDataUrl?: string;
};

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 8_000;
const YELLOW_ZONE_REPLY =
  "你好，巡邏隊已將該處單車整齊移入黃色指定停泊區，行人通道現已回復暢通，附上現場實時相片供參考…";

function suggestedTriageFor(compliance: AnalyzeCompliance): SuggestedTriage {
  if (compliance === "YELLOW_ZONE") return "URGENT_DISPATCH";
  if (compliance === "BLOCKED") return "URGENT_DISPATCH";
  return "OPPORTUNISTIC_POOL";
}

function yellowZoneStatusFor(compliance: AnalyzeCompliance): AnalyzeResult["yellowZoneStatus"] {
  if (compliance === "YELLOW_ZONE") return "ORGANIZED";
  if (compliance === "BLOCKED") return "STILL_BLOCKING";
  return "NOT_APPLICABLE";
}

function withDecision(
  result: Omit<AnalyzeResult, "suggestedTriage" | "yellowZoneStatus">,
): AnalyzeResult {
  return {
    ...result,
    yellowZoneStatus: yellowZoneStatusFor(result.compliance),
    suggestedTriage: suggestedTriageFor(result.compliance),
  };
}

function fallbackResult(landmarks: string[], captureKind?: string): AnalyzeResult {
  const organized = captureKind === "yellow" || captureKind === "upload";
  if (organized) {
    return withDecision({
      mode: "simulation",
      landmarkMatch: 96,
      residualBikes: 0,
      cleared: true,
      organizedInYellowZone: true,
      compliance: "YELLOW_ZONE",
      landmarks,
      summary: "主通道已暢通（黃線區域合規）。",
      csReply: YELLOW_ZONE_REPLY,
    });
  }
  return withDecision({
    mode: "simulation",
    landmarkMatch: 96,
    residualBikes: 0,
    cleared: true,
    organizedInYellowZone: false,
    compliance: "CLEARED",
    landmarks,
    summary: "地標與投訴點吻合，現場未見殘留單車。",
  });
}

function readLandmarks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 8);
}

function splitDataUrl(dataUrl: string) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s/g, "") };
}

function clampScore(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 96;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function clampBikes(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

async function analyzeWithGemini(body: AnalyzeBody, apiKey: string, landmarks: string[]) {
  const image = typeof body.imageDataUrl === "string" ? splitDataUrl(body.imageDataUrl) : null;
  const prompt = [
    "你是共享單車違泊現場的視覺核對員。",
    "請只根據相片判斷：地標是否與投訴地址吻合，主行人通道是否暢通，以及單車是否已整齊停在黃色格線指定泊位內。",
    `地點：${body.locationName ?? ""}`,
    `地址：${body.fullAddress ?? ""}`,
    `預期地標：${landmarks.join("、") || "無"}`,
    "residualBikes 只計停在黃色格線以外、仍然阻塞主通道的單車。整齊歸入黃線內的單車不要計入。",
    "organizedInYellowZone 在單車已整齊停進黃色格線、且主通道暢通時為 true。",
    "回傳 JSON：landmarkMatch 是 0 到 100 的整數，residualBikes 是非負整數，organizedInYellowZone 是布林值，summary 用一句繁體中文。",
  ].join("\n");

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (image && image.data.length > 0 && image.data.length < 1_800_000) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data,
      },
    });
  }

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini vision failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Gemini vision returned no JSON");
  const parsed = JSON.parse(jsonMatch[0]) as {
    landmarkMatch?: unknown;
    residualBikes?: unknown;
    organizedInYellowZone?: unknown;
    summary?: unknown;
  };
  const residualBikes = clampBikes(parsed.residualBikes);
  const organizedInYellowZone = parsed.organizedInYellowZone === true;
  const compliance: AnalyzeCompliance = organizedInYellowZone
    ? "YELLOW_ZONE"
    : residualBikes === 0
      ? "CLEARED"
      : "BLOCKED";
  return withDecision({
    mode: "live",
    landmarkMatch: clampScore(parsed.landmarkMatch),
    residualBikes,
    cleared: compliance !== "BLOCKED",
    organizedInYellowZone,
    compliance,
    landmarks,
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : organizedInYellowZone
          ? "主通道已暢通（黃線區域合規）。"
          : residualBikes === 0
            ? "地標與投訴點吻合，現場未見殘留單車。"
            : "主通道仍有單車阻塞。",
    csReply: organizedInYellowZone ? YELLOW_ZONE_REPLY : undefined,
  });
}

export async function POST(request: Request) {
  try {
    const raw = await request.json().catch(() => ({}));
    const body = (raw && typeof raw === "object" ? raw : {}) as AnalyzeBody;
    const landmarks = readLandmarks(body.landmarks);
    const captureKind = typeof body.captureKind === "string" ? body.captureKind : "cleared";
    const liveRequested = body.mode === "live";
    const apiKey = process.env.GEMINI_API_KEY?.trim();

    if (!liveRequested || !apiKey) {
      return NextResponse.json(fallbackResult(landmarks, captureKind));
    }

    try {
      const result = await analyzeWithGemini(body, apiKey, landmarks);
      return NextResponse.json(result);
    } catch {
      return NextResponse.json(fallbackResult(landmarks, captureKind));
    }
  } catch {
    return NextResponse.json(fallbackResult([], "cleared"));
  }
}
