"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useLiveStore, useOperator } from "@/lib/live-data";
import type { Anomaly } from "@/lib/types";
import { Button, Dialog, ErrorNote } from "./ui";

/** Acknowledge / resolve buttons with an optional-note confirmation dialog. */
export function AnomalyActions({ anomaly, onChange, size = "xs" }: { anomaly: Anomaly; onChange?: (a: Anomaly) => void; size?: "xs" | "sm" }) {
  const store = useLiveStore();
  const [operator] = useOperator();
  const [mode, setMode] = useState<"acknowledge" | "resolve" | null>(null);
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useAction();

  async function submit() {
    if (!mode) return;
    const updated = await run(() => (mode === "acknowledge" ? api.acknowledge(anomaly.id, note.trim() || undefined) : api.resolve(anomaly.id, note.trim() || undefined)));
    if (updated) {
      store?.upsertAnomaly(updated);
      onChange?.(updated);
      setMode(null);
      setNote("");
    }
  }

  const close = () => {
    setMode(null);
    setError(null);
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <Button size={size} variant="warning" disabled={anomaly.status !== "ACTIVE"} onClick={() => setMode("acknowledge")} title="Acknowledge">
          ACK
        </Button>
        <Button size={size} variant="primary" disabled={anomaly.status === "RESOLVED"} onClick={() => setMode("resolve")} title="Resolve">
          RESOLVE
        </Button>
      </div>
      <Dialog
        open={mode !== null}
        onClose={close}
        title={`${mode === "acknowledge" ? "Acknowledge" : "Resolve"} anomaly`}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant={mode === "acknowledge" ? "warning" : "primary"} onClick={submit} disabled={busy}>
              {busy ? "Sending…" : mode === "acknowledge" ? "Acknowledge" : "Resolve"}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-xs">
          <div className="text-ink">
            <span className="num text-muted">{anomaly.id}</span> · {anomaly.severity} · {anomaly.subsystems.join("/")}
          </div>
          <div className="text-ink-2">{anomaly.description}</div>
          <div className="text-muted">
            As operator <span className="num text-ink">{operator}</span>
          </div>
          <label className="flex flex-col gap-1">
            <span className="label">Note (optional)</span>
            <textarea className="field min-h-[70px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Dialog>
    </>
  );
}
