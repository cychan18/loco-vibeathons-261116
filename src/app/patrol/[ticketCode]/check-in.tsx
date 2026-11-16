"use client";

import { useQuery } from "convex/react";
import { use } from "react";
import { PatrolProofCard } from "@/components/PatrolProofCard";
import { api } from "../../../../convex/_generated/api";

export function PatrolCheckIn({
  params,
}: {
  params: Promise<{ ticketCode: string }>;
}) {
  const { ticketCode } = use(params);
  const ticket = useQuery(api.tickets.getTicketByCode, { ticketCode });

  return (
    <main className="min-h-screen bg-[#07110d] px-4 py-6 text-emerald-50">
      <p className="text-center text-[11px] tracking-[0.18em] text-emerald-200/60">LOCO SMARTPATROL</p>
      <h1 className="mt-1 text-center text-lg font-semibold text-white">現場順路打卡</h1>
      <p className="mt-1 text-center font-mono text-xs text-emerald-100/50">{ticketCode}</p>
      <div className="mt-4">
        {ticket === undefined ? (
          <p className="text-center text-sm text-emerald-100/70">正在讀取工單…</p>
        ) : ticket === null ? (
          <p className="text-center text-sm text-emerald-100/70">找不到工單 {ticketCode}</p>
        ) : (
          <PatrolProofCard ticket={ticket} visionMode="fast" />
        )}
      </div>
    </main>
  );
}
