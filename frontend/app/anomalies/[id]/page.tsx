"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { AIExplanation } from "@/components/ai-explanation";
import { AnomalyActions } from "@/components/anomaly-actions";
import { Button, EmptyState, ErrorNote, PageHeader, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtUtc, toMs } from "@/lib/formatters";
import { useAction, useApi } from "@/lib/hooks";
import { useLive, useLiveStore } from "@/lib/live-data";
import type { AnomalyDetail } from "@/lib/types";

export default function AnomalyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const live = useLive();
  const store = useLiveStore();
  const detail = useApi((signal) => api.anomaly(id, signal), [id]);
  const replayAct = useAction();

  // keep status fields in sync with live WS updates (ack/resolve from another console, score updates)
  const liveVersion = live.anomalies.find((a) => a.id === id);
  const { setData } = detail;
  useEffect(() => {
    if (!liveVersion) return;
    setData((prev) => (prev ? ({ ...prev, ...liveVersion, context: prev.context, score_trace: prev.score_trace } as AnomalyDetail) : prev));
  }, [liveVersion, setData]);

  const a = detail.data;

  async function replayEvent() {
    if (!a?.run_id) return;
    const start = new Date(toMs(a.onset_time) - 60_000).toISOString();
    const s = await replayAct.run(() => api.replayStart({ run_id: a.run_id as string, start, speed: 1 }));
    if (s) {
      store?.setSimulation(s);
      router.push("/simulation#replay");
    }
  }

  if (!a) {
    return (
      <div>
        <PageHeader title="Anomaly" subtitle={<span className="num">{id}</span>} />
        {detail.error ? <ErrorNote>Could not load anomaly: {detail.error}</ErrorNote> : <EmptyState>Loading…</EmptyState>}
        <Link href="/anomalies" className="mt-2 inline-block text-xs text-accent hover:underline">
          ← Anomaly center
        </Link>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={a.description || "Anomaly investigation"}
        subtitle={
          <span className="num">
            <Link href="/anomalies" className="text-accent hover:underline">
              Anomalies
            </Link>{" "}
            / {a.id} · detected {fmtUtc(a.timestamp)}
          </span>
        }
        actions={
          <>
            <StatusBadge status={a.severity} />
            <StatusBadge status={a.status} />
            <AnomalyActions anomaly={a} size="sm" onChange={(u) => detail.setData((prev) => (prev ? { ...prev, ...u } : prev))} />
            <Button variant="primary" onClick={replayEvent} disabled={!a.run_id || replayAct.busy} title={a.run_id ? "Replay from onset − 60 s" : "No recorded run for this anomaly"}>
              ⟲ Replay this event
            </Button>
          </>
        }
      />
      {replayAct.error ? (
        <div className="mb-2">
          <ErrorNote>Replay failed: {replayAct.error}</ErrorNote>
        </div>
      ) : null}
      <AIExplanation anomaly={a} />
    </div>
  );
}
