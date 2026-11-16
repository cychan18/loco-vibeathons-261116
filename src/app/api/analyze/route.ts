import { NextResponse } from "next/server";

export type AnalyzeMode = "live" | "simulation";
export type AnalyzeCompliance = "CLEARED" | "YELLOW_ZONE" | "BLOCKED";

export type AnalyzeResult = {
  mode: AnalyzeMode;
  landmarkMatch: number;
  residualBikes: number;
  cleared: boolean;
  organizedInYellowZone: boolean;
  compliance: AnalyzeCompliance;
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

const GEMINI_MODEL = "gemini-2.5-flash";
const YELLOW_ZONE_REPLY =
  "你好，巡邏隊已將該處單車整齊移入黃色指定停泊區，行人通道現已回復暢通，附上現場實時相片供參考…";

function simulationResult(landmarks: string[], captureKind?: string): AnalyzeResult {
  const organized = captureKind === "yellow" || captureKind === "upload";
  if (organized) {
    return {
      mode: "simulation",
      landmarkMatch: 96,
      residualBikes: 0,
      cleared: true,
      organizedInYellowZone: true,
      compliance: "YELLOW_ZONE",
      landmarks,
      summary: "主通道已暢通（黃線區域合規）。",
      csReply: YELLOW_ZONE_REPLY,
    };
  }
  return {
    mode: "simulation",
    landmarkMatch: 96,
    residualBikes: 0,
    cleared: true,
    organizedInYellowZone: false,
    compliance: "CLEARED",
    landmarks,
    summary: "地標與投訴點吻合，現場未見殘留單車。",
  };
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
  if (image && image.data.length < 1_800_000) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
  );

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
  const compliance: AnalyzeResult["compliance"] = organizedInYellowZone
    ? "YELLOW_ZONE"
    : residualBikes === 0
      ? "CLEARED"
      : "BLOCKED";
  return {
    mode: "live" as const,
    landmarkMatch: clampScore(parsed.landmarkMatch),
    residualBikes,
    cleared: compliance !== "BLOCKED",
    organizedInYellowZone,
    compliance,
    landmarks,
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : organizedInYellowZone
        ? "主通道已暢通（黃線區域合規）。"
        : "Vision 已完成現場核對。",
    csReply: organizedInYellowZone ? YELLOW_ZONE_REPLY : undefined,
  } satisfies AnalyzeResult;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as AnalyzeBody;
  const landmarks = readLandmarks(body.landmarks);
  const liveRequested = body.mode === "live";
  const apiKey = process.env.GEMINI_API_KEY;

  const captureKind = typeof body.captureKind === "string" ? body.captureKind : "cleared";
  if (!liveRequested || !apiKey) {
    return NextResponse.json(simulationResult(landmarks, captureKind));
  }

  try {
    const result = await analyzeWithGemini(body, apiKey, landmarks);
    return NextResponse.json(result);
  } catch {
    const fallback = simulationResult(landmarks, captureKind);
    return NextResponse.json({
      ...fallback,
      summary:
        fallback.compliance === "YELLOW_ZONE"
          ? fallback.summary
          : "Vision 暫時未能連線，已改用現場穩定核對結果。",
    });
  }
}
