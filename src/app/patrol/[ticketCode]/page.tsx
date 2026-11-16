import { Suspense } from "react";
import { PatrolCheckIn } from "./check-in";

export default function PatrolCheckInPage({
  params,
}: {
  params: Promise<{ ticketCode: string }>;
}) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[#07110d] px-4 py-6 text-center text-sm text-emerald-50">
          正在讀取工單…
        </main>
      }
    >
      <PatrolCheckIn params={params} />
    </Suspense>
  );
}
