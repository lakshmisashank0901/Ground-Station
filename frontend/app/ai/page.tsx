"use client";

import { DetectorBars, FeatureTable } from "@/components/ai-explanation";
import { LiveScoreChart } from "@/components/score-chart";
import { Button, EmptyState, ErrorNote, KV, PageHeader, Panel, ScoreBar, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { DETECTOR_COLORS, DETECTOR_LABELS, fmtAge, fmtMs, fmtNum, fmtPct01, fmtScore, fmtUtc, humanize, isNum, scoreColor } from "@/lib/formatters";
import { useAction, useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";

const KEY_METRICS = ["precision", "recall", "f1"];
function pickMetrics(m: Record<string, number>): [string, number][] {
  const keys = KEY_METRICS.filter((k) => k in m);
  const rest = Object.keys(m).filter((k) => !keys.includes(k));
  return [...keys, ...rest].slice(0, 3).map((k) => [k, m[k]]);
}

function pct(v: number | null | undefined) {
  return isNum(v) ? `${(v * 100).toFixed(1)}%` : "—";
}

export default function AIPage() {
  const live = useLive();
  const online = live.backend.state === "ONLINE";
  const models = useApi(() => api.models(), [online], { intervalMs: 15_000 });
  const metrics = useApi(() => api.modelMetrics(), [online]);
  const retrain = useAction();
  const inf = live.latestHealth?.inference ?? null;
  const m = metrics.data;
  const training = models.data?.some((x) => x.status === "TRAINING") || live.system?.ml.status === "TRAINING";

  async function doRetrain() {
    if (!window.confirm("Retrain all detectors on the current training dataset?")) return;
    const r = await retrain.run(() => api.retrain());
    if (r) models.reload();
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title="AI / anomaly detection"
        subtitle={
          <span className="num">
            ML engine {live.system?.ml.status ?? "—"} · model {live.system?.ml.model_version ?? inf?.model_version ?? "—"} · inference{" "}
            {fmtMs(live.system?.ml.inference_latency_ms)}
          </span>
        }
        actions={
          <>
            {training ? <StatusBadge status="TRAINING" /> : null}
            <Button variant="warning" onClick={doRetrain} disabled={retrain.busy || training}>
              {retrain.busy ? "Requesting…" : "⟳ Retrain models"}
            </Button>
          </>
        }
      />
      {retrain.error ? <ErrorNote>Retrain failed: {retrain.error}</ErrorNote> : null}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Live fused anomaly score · detector breakdown">
          <LiveScoreChart height={240} />
        </Panel>
        <Panel title="Latest inference">
          {!inf ? (
            <EmptyState>No inference received</EmptyState>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="num text-2xl font-bold" style={{ color: scoreColor(inf.anomaly_score) }}>
                  {fmtScore(inf.anomaly_score)}
                </span>
                <StatusBadge status={inf.severity} />
              </div>
              <KV
                cols={3}
                items={[
                  ["Confidence", fmtPct01(inf.confidence)],
                  ["Mahalanobis dist.", fmtNum(inf.raw.mahalanobis_distance)],
                  ["LSTM error", fmtNum(inf.raw.lstm_error)],
                  ["IF raw", fmtNum(inf.raw.isolation_forest_raw)],
                  ["Sequence", inf.sequence],
                  ["Time", fmtUtc(inf.timestamp).slice(11)],
                ]}
              />
              <DetectorBars detectors={inf.detectors} weights={m?.fusion.weights} />
              <div className="num text-[10px] text-muted">affected: {inf.affected_subsystems.join(", ") || "none"}</div>
            </div>
          )}
        </Panel>
      </div>

      {inf?.top_features.length ? (
        <Panel title="Current top contributing features">
          <FeatureTable features={inf.top_features} />
        </Panel>
      ) : null}

      <Panel title="Models" bodyClassName="p-0 overflow-x-auto">
        {models.error && !models.data ? (
          <EmptyState>Models unavailable ({models.error})</EmptyState>
        ) : !models.data?.length ? (
          <EmptyState>{models.loading ? "Loading…" : "No models reported"}</EmptyState>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Model</th>
                <th>Status</th>
                <th>Version</th>
                <th>Backend</th>
                <th>Trained</th>
                <th>Dataset</th>
                <th className="text-right!">Features</th>
                <th className="text-right!">Fusion weight</th>
                <th>Thresholds</th>
                <th>Metrics</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((x) => (
                <tr key={x.name}>
                  <td>
                    <span className="flex items-center gap-1.5">
                      {DETECTOR_COLORS[x.name] ? <span className="inline-block h-[2px] w-3" style={{ background: DETECTOR_COLORS[x.name] }} /> : null}
                      <span className="font-semibold text-ink">{DETECTOR_LABELS[x.name] ?? x.name}</span>
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={x.status} />
                  </td>
                  <td className="num">{x.version}</td>
                  <td className="num text-ink-2">{x.backend}</td>
                  <td className="num whitespace-nowrap">{x.trained_at ? fmtUtc(x.trained_at) : "—"}</td>
                  <td className="num text-ink-2">{x.training_dataset ?? "—"}</td>
                  <td className="num text-right" title={x.feature_set.join(", ")}>
                    {x.feature_set.length}
                  </td>
                  <td className="num text-right">{x.fusion_weight.toFixed(2)}</td>
                  <td className="num text-[10px] text-ink-2">
                    {Object.entries(x.thresholds).map(([k, v]) => (
                      <div key={k}>
                        {k}={fmtNum(v)}
                      </div>
                    ))}
                  </td>
                  <td className="num text-[10px] text-ink-2" title={Object.entries(x.metrics).map(([k, v]) => `${k}=${fmtNum(v)}`).join("\n")}>
                    {pickMetrics(x.metrics).map(([k, v]) => (
                      <div key={k}>
                        {k}={fmtNum(v)}
                      </div>
                    ))}
                    {Object.keys(x.metrics).length > 3 ? <div className="text-muted">+{Object.keys(x.metrics).length - 3} more</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="Detector evaluation"
          actions={<span className="num text-[10px] text-muted">{m ? `${m.dataset ?? "—"} · ${m.evaluated_at ? fmtUtc(m.evaluated_at) : "not evaluated"}` : ""}</span>}
          bodyClassName="p-0 overflow-x-auto"
        >
          {!m ? (
            <EmptyState>{metrics.error ? `Metrics unavailable (${metrics.error})` : "Loading…"}</EmptyState>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Detector</th>
                  <th className="text-right!">Precision</th>
                  <th className="text-right!">Recall</th>
                  <th className="text-right!">F1</th>
                  <th className="text-right!">FPR</th>
                  <th className="text-right!">FNR</th>
                  <th className="text-right!">Mean delay</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(m.detectors).map(([k, d]) => (
                  <tr key={k}>
                    <td className="font-semibold text-ink">{DETECTOR_LABELS[k] ?? k}</td>
                    <td className="num text-right">{pct(d.precision)}</td>
                    <td className="num text-right">{pct(d.recall)}</td>
                    <td className="num text-right font-semibold text-white">{pct(d.f1)}</td>
                    <td className="num text-right">{pct(d.false_positive_rate)}</td>
                    <td className="num text-right">{pct(d.false_negative_rate)}</td>
                    <td className="num text-right">{fmtAge(d.mean_detection_delay_s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Per-scenario detection" bodyClassName="p-0 overflow-x-auto">
          {!m ? (
            <EmptyState>—</EmptyState>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Detection rate</th>
                  <th className="text-right!">Mean delay</th>
                  <th className="text-right!">Runs</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(m.per_scenario).map(([k, s]) => (
                  <tr key={k}>
                    <td className="text-ink">{humanize(k)}</td>
                    <td className="w-48">
                      <ScoreBar value={s.detection_rate} color="#38bdf8" />
                    </td>
                    <td className="num text-right">{s.mean_detection_delay_s === null ? "—" : fmtAge(s.mean_detection_delay_s)}</td>
                    <td className="num text-right">{s.runs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Fusion & thresholds">
          {!m ? (
            <EmptyState>—</EmptyState>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="label mb-1.5">Fusion weights</div>
                <div className="space-y-1.5">
                  {Object.entries(m.fusion.weights).map(([k, w]) => (
                    <ScoreBar key={k} label={DETECTOR_LABELS[k] ?? k} value={w} color={DETECTOR_COLORS[k] ?? "#38bdf8"} />
                  ))}
                </div>
                <div className="num mt-1.5 text-[11px] text-muted">floor gain {fmtNum(m.fusion.floor_gain)}</div>
              </div>
              <div>
                <div className="label mb-1.5">Thresholds</div>
                <KV items={Object.entries(m.thresholds).map(([k, v]) => [k, fmtNum(v)])} />
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Inference latency">
          {!m ? (
            <EmptyState>—</EmptyState>
          ) : (
            <KV
              cols={3}
              items={[
                ["Mean (eval)", fmtMs(m.inference_latency_ms.mean)],
                ["p95 (eval)", fmtMs(m.inference_latency_ms.p95)],
                ["Live", fmtMs(live.system?.ml.inference_latency_ms)],
                ["Models loaded", live.system?.ml.models_loaded.join(", ") || "—"],
                ["ML status", live.system?.ml.status ?? "—"],
                ["Model version", live.system?.ml.model_version ?? "—"],
              ]}
            />
          )}
        </Panel>
      </div>
    </div>
  );
}
