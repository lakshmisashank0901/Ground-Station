"use client";

import { useEffect, useState } from "react";
import { ReportView } from "@/components/report-view";
import { Button, cx, EmptyState, ErrorNote, Field, PageHeader, Panel, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtUtc, fromUtcInputValue, humanize, toUtcInputValue } from "@/lib/formatters";
import { useAction, useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";
import type { Report } from "@/lib/types";

type Scope = "hour" | "run" | "range";

export default function ReportsPage() {
  const live = useLive();
  const online = live.backend.state === "ONLINE";
  const list = useApi(() => api.reports(), [online]);
  const runs = useApi(() => api.runs(), [online]);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<Scope>("hour");
  const [runId, setRunId] = useState("");
  const [start, setStart] = useState(() => toUtcInputValue(Date.now() - 3_600_000));
  const [end, setEnd] = useState(() => toUtcInputValue(Date.now()));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Report | null>(null);
  const gen = useAction();
  const report = useApi(() => (selectedId && generated?.id !== selectedId ? api.report(selectedId) : Promise.resolve(generated)), [selectedId]);
  useEffect(() => {
    if (!selectedId && list.data?.length) setSelectedId(list.data[0].id);
  }, [list.data, selectedId]);
  const shown = selectedId && generated?.id === selectedId ? generated : report.data;

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    const body: { title?: string; start?: string; end?: string; run_id?: string } = {};
    if (title.trim()) body.title = title.trim();
    if (scope === "run") {
      if (!runId) return gen.setError("Select a run");
      body.run_id = runId;
    } else if (scope === "range") {
      const s = fromUtcInputValue(start);
      const en = fromUtcInputValue(end);
      if (!s || !en || s >= en) return gen.setError("Enter a valid UTC interval");
      body.start = s;
      body.end = en;
    }
    const r = await gen.run(() => api.generateReport(body));
    if (r) {
      setGenerated(r);
      setSelectedId(r.id);
      list.reload();
    }
  }

  return (
    <div>
      <PageHeader title="Mission reports" subtitle="Summaries of a mission interval: health, anomalies, detection delay, data quality" />
      <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Panel title="Generate report">
            <form onSubmit={generate} className="space-y-2.5">
              <Field label="Title (optional)">
                <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Mission health report" />
              </Field>
              <div className="flex flex-col gap-1">
                <span className="label">Interval</span>
                <Segmented
                  options={[
                    { value: "hour", label: "Last 1 h" },
                    { value: "run", label: "Simulation run" },
                    { value: "range", label: "Time range" },
                  ]}
                  value={scope}
                  onChange={(v) => setScope(v as Scope)}
                />
              </div>
              {scope === "run" ? (
                <Field label="Run">
                  <select className="field" value={runId} onChange={(e) => setRunId(e.target.value)}>
                    <option value="">{runs.data?.length ? "— select run —" : "No runs"}</option>
                    {runs.data?.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name || r.id} · {humanize(r.scenario)} · {fmtUtc(r.start_time)}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {scope === "range" ? (
                <div className="grid grid-cols-1 gap-2">
                  <Field label="Start (UTC)">
                    <input type="datetime-local" step={1} className="field num" value={start} onChange={(e) => setStart(e.target.value)} />
                  </Field>
                  <Field label="End (UTC)">
                    <input type="datetime-local" step={1} className="field num" value={end} onChange={(e) => setEnd(e.target.value)} />
                  </Field>
                </div>
              ) : null}
              <Button type="submit" variant="primary" disabled={gen.busy}>
                {gen.busy ? "Generating…" : "Generate report"}
              </Button>
              <ErrorNote>{gen.error}</ErrorNote>
            </form>
          </Panel>
          <Panel title={`Reports · ${list.data?.length ?? 0}`} bodyClassName="p-0 max-h-[50vh] overflow-auto">
            {!list.data?.length ? (
              <EmptyState>{list.error ? `Unavailable (${list.error})` : list.loading ? "Loading…" : "No reports yet"}</EmptyState>
            ) : (
              <ul>
                {list.data.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={cx("block w-full border-b border-line px-2.5 py-1.5 text-left hover:bg-panel-2", selectedId === r.id && "bg-accent/10")}
                    >
                      <div className="truncate text-[12px] text-ink">{r.title}</div>
                      <div className="num text-[10px] text-muted">
                        {fmtUtc(r.start)} → {fmtUtc(r.end).slice(11)} · {r.anomaly_count} anomalies
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="min-w-0">
          {shown ? (
            <ReportView report={shown} />
          ) : (
            <Panel>
              <EmptyState className="h-64">{report.error ? `Could not load report: ${report.error}` : selectedId ? "Loading report…" : "Select or generate a report"}</EmptyState>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
