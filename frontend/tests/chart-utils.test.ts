import { describe, expect, it } from "vitest";
import { computeYDomain, markersFor, plotValue, rowsToPoints, windowMs } from "@/lib/chart-utils";
import { deriveConnection, healthPointFromUpdate } from "@/lib/live-store";
import { deriveWsUrl } from "@/lib/config";
import type { Anomaly, HealthUpdate } from "@/lib/types";

const enumDef = { type: "enum" as const, enum_values: ["IDLE", "ACTIVE", "SAFE"] };

describe("chart utils", () => {
  it("maps enum values to indices", () => {
    expect(plotValue("ACTIVE", enumDef)).toBe(1);
    expect(plotValue("BOGUS", enumDef)).toBeNull();
    expect(plotValue(3.5)).toBe(3.5);
    expect(plotValue(null)).toBeNull();
  });
  it("converts rows to points", () => {
    const pts = rowsToPoints(
      [
        { timestamp: "2026-10-05T00:00:00.000Z", data: { x: 1 } },
        { timestamp: "bad", data: { x: 2 } },
        { timestamp: "2026-10-05T00:00:01.000Z", data: {} },
      ],
      "x",
    );
    expect(pts).toHaveLength(2);
    expect(pts[0].v).toBe(1);
    expect(pts[1].v).toBeNull();
  });
  it("computes y domain including nearby nominal band", () => {
    const [lo, hi] = computeYDomain([7, 7.2, 7.4], { nominal_min: 6.8, nominal_max: 8.4, type: "float" });
    expect(lo).toBeLessThan(6.8);
    expect(hi).toBeGreaterThan(7.4);
    const far = computeYDomain([50, 51], { nominal_min: -100, nominal_max: 1000, type: "float" });
    expect(far[0]).toBeGreaterThan(40);
    expect(computeYDomain([], { nominal_min: 1, nominal_max: 2, type: "float" })).toEqual([1, 2]);
    expect(computeYDomain([1], enumDef as never)).toEqual([-0.5, 2.5]);
  });
  it("window sizes", () => {
    expect(windowMs("10s")).toBe(10_000);
    expect(windowMs("1h")).toBe(3_600_000);
  });
  it("filters anomaly markers by time and subsystem/feature", () => {
    const base = { onset_time: "2026-10-05T00:00:10.000Z", timestamp: "2026-10-05T00:00:12.000Z", top_features: [] } as unknown as Anomaly;
    const a1 = { ...base, id: "a1", subsystems: ["OBC"] } as Anomaly;
    const a2 = { ...base, id: "a2", subsystems: ["EPS"], top_features: [{ feature: "obc_temperature" }] } as unknown as Anomaly;
    const a3 = { ...base, id: "a3", subsystems: ["COMM"] } as Anomaly;
    const t0 = Date.parse("2026-10-05T00:00:00.000Z");
    const ids = markersFor([a1, a2, a3], t0, t0 + 60_000, { name: "obc_temperature", subsystem: "OBC" }).map((a) => a.id);
    expect(ids).toEqual(["a1", "a2"]);
    expect(markersFor([a1], t0 + 20_000, t0 + 60_000)).toEqual([]);
  });
});

describe("live-store helpers", () => {
  const closed = { state: "CLOSED" as const, attempts: 0, lastMessageAt: null, messages: 0 };
  const open = { ...closed, state: "OPEN" as const };
  it("derives connection state", () => {
    expect(deriveConnection("OFFLINE", { telemetry: open, health: open, anomalies: open, system: open }, null)).toBe("DISCONNECTED");
    expect(deriveConnection("ONLINE", { telemetry: open, health: open, anomalies: open, system: open }, null)).toBe("CONNECTED");
    expect(deriveConnection("ONLINE", { telemetry: open, health: closed, anomalies: open, system: open }, null)).toBe("DEGRADED");
    expect(deriveConnection("UNKNOWN", { telemetry: closed, health: closed, anomalies: closed, system: closed }, null)).toBe("DISCONNECTED");
  });
  it("builds health points", () => {
    const h = {
      type: "health",
      timestamp: "2026-10-05T00:00:00.000Z",
      overall_score: 92,
      status: "NOMINAL",
      trend: "flat",
      anomaly_score: 0.1,
      subsystems: [{ id: "eps", name: "EPS", status: "NOMINAL", health_score: 95, key_values: {}, active_anomalies: 0 }],
      inference: null,
    } as HealthUpdate;
    const p = healthPointFromUpdate(h);
    expect(p.overall).toBe(92);
    expect(p.subsystems.eps).toBe(95);
    expect(p.rule).toBeNull();
  });
  it("derives ws url", () => {
    expect(deriveWsUrl("http://localhost:8000/")).toBe("ws://localhost:8000");
    expect(deriveWsUrl("https://gs.example.com")).toBe("wss://gs.example.com");
  });
});
