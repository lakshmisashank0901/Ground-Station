"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnomalyActions } from "@/components/anomaly-actions";
import { Button, EmptyState, ErrorNote, Field, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { DETECTOR_COLORS, DETECTOR_LABELS, fmtPct01, fmtScore, fmtUtc, scoreColor, toMs, toneColor } from "@/lib/formatters";
import { useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";
import type { Anomaly, AnomalyStatus, Severity } from "@/lib/types";

const STATUSES: AnomalyStatus[] = ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"];
const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "WARNING", "INFO"];
const SUBSYSTEMS = ["EPS", "OBC", "ADCS", "COMM", "PAYLOAD"];
const DETS = ["rule", "mahalanobis", "isolation_forest", "lstm"] as const;

function DetectorMini({ a }: { a: Anomaly }) {
  return (
    <div className="flex items-end gap-[3px]" title={DETS.map((d) => `${DETECTOR_LABELS[d]} ${fmtScore(a.detectors[d])}`).join("\n")}>
      {DETS.map((d) => {
        const v = a.detectors[d];
        return (
          <div key={d} className="flex flex-col items-center">
            <div className="relative h-5 w-2 overflow-hidden rounded-[1px] bg-panel-3">
              {v !== null ? <div className="absolute bottom-0 w-full" style={{ height: `${Math.min(1, v) * 100}%`, background: DETECTOR_COLORS[d] }} /> : null}
            </div>
            <span className="num text-[7px] text-muted">{d === "isolation_forest" ? "IF" : d === "mahalanobis" ? "MD" : d === "lstm" ? "LS" : "RU"}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function AnomaliesPage() {
  const live = useLive();
  const [status, setStatus] = useState<AnomalyStatus | "">("");
  const [severity, setSeverity] = useState<Severity | "">("");
  const [subsystem, setSubsystem] = useState("");
  const [search, setSearch] = useState("");

  // initial filter from ?status=… (top-bar alarm link)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("status")?.toUpperCase();
    if (s && (STATUSES as string[]).includes(s)) setStatus(s as AnomalyStatus);
    const sev = p.get("severity")?.toUpperCase();
    if (sev && (SEVERITIES as string[]).includes(sev)) setSeverity(sev as Severity);
  }, []);

  const rest = useApi((signal) => api.anomalies({ status, severity, subsystem, limit: 200 }, signal), [status, severity, subsystem, live.backend.state === "ONLINE"], {
    intervalMs: 30_000,
  });

  const rows = useMemo(() => {
    const m = new Map<string, Anomaly>();
    for (const a of rest.data ?? []) m.set(a.id, a);
    // live updates (status changes, new detections) override REST rows
    for (const a of live.anomalies) {
      if (m.has(a.id) || ((!status || a.status === status) && (!severity || a.severity === severity) && (!subsystem || a.subsystems.includes(subsystem)))) {
        m.set(a.id, a);
      }
    }
    let list = Array.from(m.values()).filter((a) => (!status || a.status === status) && (!severity || a.severity === severity) && (!subsystem || a.subsystems.includes(subsystem)));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((a) => `${a.description} ${a.id} ${a.top_features.map((f) => f.feature).join(" ")}`.toLowerCase().includes(q));
    return list.sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));
  }, [rest.data, live.anomalies, status, severity, subsystem, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of rows) c[a.severity] = (c[a.severity] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div>
      <PageHeader
        title="Anomaly center"
        subtitle={`${rows.length} events shown · ${live.activeAlarms} active`}
        actions={SEVERITIES.map((s) => (
          <StatusBadge key={s} status={s} label={`${s} ${counts[s] ?? 0}`} />
        ))}
      />
      <Panel bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-2">
          <Field label="Status">
            <select className="field" value={status} onChange={(e) => setStatus(e.target.value as AnomalyStatus | "")}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select className="field" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "")}>
              <option value="">All</option>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Subsystem">
            <select className="field" value={subsystem} onChange={(e) => setSubsystem(e.target.value)}>
              <option value="">All</option>
              {SUBSYSTEMS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input className="field w-52" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="description, feature, id" />
          </Field>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStatus("");
              setSeverity("");
              setSubsystem("");
              setSearch("");
            }}
          >
            Clear
          </Button>
          <Button size="sm" onClick={rest.reload} className="ml-auto">
            ↻ Refresh
          </Button>
        </div>
        {rest.error && !rows.length ? (
          <div className="p-2">
            <ErrorNote>Could not load anomalies: {rest.error}</ErrorNote>
          </div>
        ) : null}
        <div className="max-h-[calc(100vh-200px)] overflow-auto">
          {rows.length === 0 ? (
            <EmptyState>{rest.loading ? "Loading…" : "No anomalies match the filters"}</EmptyState>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Detected (UTC)</th>
                  <th>Subsystems</th>
                  <th>Description</th>
                  <th className="text-right!">Score / peak</th>
                  <th className="text-right!">Conf.</th>
                  <th>Detectors</th>
                  <th>Top features</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} style={{ boxShadow: `inset 3px 0 0 ${toneColor(a.severity)}` }}>
                    <td>
                      <StatusBadge status={a.severity} />
                    </td>
                    <td className="num whitespace-nowrap">{fmtUtc(a.timestamp)}</td>
                    <td className="num">{a.subsystems.join(", ")}</td>
                    <td className="max-w-[280px]">
                      <Link href={`/anomalies/${encodeURIComponent(a.id)}`} className="line-clamp-2 text-ink hover:text-accent" title={a.description}>
                        {a.description || a.id}
                      </Link>
                    </td>
                    <td className="num text-right whitespace-nowrap">
                      <span style={{ color: scoreColor(a.score) }}>{fmtScore(a.score)}</span>
                      <span className="text-muted"> / </span>
                      <span style={{ color: scoreColor(a.peak_score) }}>{fmtScore(a.peak_score)}</span>
                    </td>
                    <td className="num text-right">{fmtPct01(a.confidence)}</td>
                    <td>
                      <DetectorMini a={a} />
                    </td>
                    <td className="num max-w-[200px] text-[11px] text-ink-2">
                      {a.top_features.slice(0, 3).map((f) => (
                        <div key={f.feature} className="truncate">
                          {f.feature} <span className="text-muted">{(f.contribution * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <Link href={`/anomalies/${encodeURIComponent(a.id)}`} className="inline-flex h-[22px] items-center rounded-[3px] border border-line-2 bg-panel-2 px-1.5 text-[11px] text-ink hover:border-accent">
                          VIEW
                        </Link>
                        <AnomalyActions anomaly={a} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}
