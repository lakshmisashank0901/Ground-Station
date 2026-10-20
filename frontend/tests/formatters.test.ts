import { describe, expect, it } from "vitest";
import {
  fmtAge,
  fmtDuration,
  fmtNum,
  fmtPct01,
  fmtRange,
  fmtUtc,
  fmtUtcTime,
  fmtValue,
  formatErrorDetail,
  fromUtcInputValue,
  healthToStatus,
  humanize,
  rangeState,
  scoreToState,
  severityRank,
  statusTone,
  toUtcInputValue,
  trendOf,
  worstSeverity,
} from "@/lib/formatters";

describe("numbers", () => {
  it("formats by magnitude and handles null", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtNum(undefined)).toBe("—");
    expect(fmtNum(NaN)).toBe("—");
    expect(fmtNum(42)).toBe("42");
    expect(fmtNum(7.4219)).toBe("7.42");
    expect(fmtNum(123.456)).toBe("123.5");
    expect(fmtNum(0.12345)).toBe("0.123");
    expect(fmtNum(3.14159, 1)).toBe("3.1");
    expect(fmtNum("OK")).toBe("OK");
  });
  it("adds units", () => {
    expect(fmtValue(7.42, "V")).toBe("7.42 V");
    expect(fmtValue(55, "%")).toBe("55%");
    expect(fmtValue("ACTIVE", "")).toBe("ACTIVE");
    expect(fmtValue(null, "V")).toBe("—");
  });
  it("formats 0–1 as percent", () => {
    expect(fmtPct01(0.873)).toBe("87%");
    expect(fmtPct01(null)).toBe("—");
  });
});

describe("time", () => {
  const iso = "2026-10-05T14:31:27.045Z";
  it("formats UTC", () => {
    expect(fmtUtcTime(iso)).toBe("14:31:27");
    expect(fmtUtcTime(iso, true)).toBe("14:31:27.045");
    expect(fmtUtc(iso)).toBe("2026-10-05 14:31:27Z");
    expect(fmtUtc("garbage")).toBe("—");
  });
  it("formats ages and durations", () => {
    expect(fmtAge(0.83)).toBe("0.8s");
    expect(fmtAge(12.7)).toBe("12s");
    expect(fmtAge(184)).toBe("3m 04s");
    expect(fmtAge(7500)).toBe("2h 05m");
    expect(fmtAge(null)).toBe("—");
    expect(fmtDuration(3 * 86400 + 4 * 3600 + 5 * 60 + 6)).toBe("3d 04:05:06");
    expect(fmtDuration(65)).toBe("00:01:05");
  });
  it("round-trips datetime-local values as UTC", () => {
    const ms = Date.parse(iso);
    const v = toUtcInputValue(ms);
    expect(v).toBe("2026-10-05T14:31:27");
    expect(fromUtcInputValue(v)).toBe("2026-10-05T14:31:27.000Z");
    expect(fromUtcInputValue("2026-10-05T14:31")).toBe("2026-10-05T14:31:00.000Z");
    expect(fromUtcInputValue("")).toBeNull();
  });
});

describe("severity mapping (contract §1)", () => {
  it("maps anomaly score bands", () => {
    expect(scoreToState(0)).toBe("NORMAL");
    expect(scoreToState(0.29)).toBe("NORMAL");
    expect(scoreToState(0.3)).toBe("WARNING");
    expect(scoreToState(0.59)).toBe("WARNING");
    expect(scoreToState(0.6)).toBe("HIGH");
    expect(scoreToState(0.79)).toBe("HIGH");
    expect(scoreToState(0.8)).toBe("CRITICAL");
    expect(scoreToState(null)).toBe("NORMAL");
  });
  it("maps health 0–100 via 1 - h/100", () => {
    expect(healthToStatus(100)).toBe("NOMINAL");
    expect(healthToStatus(71)).toBe("NOMINAL");
    expect(healthToStatus(70)).toBe("WARNING");
    expect(healthToStatus(40)).toBe("HIGH");
    expect(healthToStatus(20)).toBe("CRITICAL");
    expect(healthToStatus(null)).toBe("UNKNOWN");
  });
  it("tones and ranks", () => {
    expect(statusTone("NOMINAL")).toBe("nominal");
    expect(statusTone("warning")).toBe("warning");
    expect(statusTone("HIGH")).toBe("high");
    expect(statusTone("CRITICAL")).toBe("critical");
    expect(statusTone("DISCONNECTED")).toBe("offline");
    expect(statusTone("???")).toBe("unknown");
    expect(severityRank("CRITICAL")).toBeGreaterThan(severityRank("HIGH"));
    expect(severityRank("HIGH")).toBeGreaterThan(severityRank("WARNING"));
    expect(severityRank("WARNING")).toBeGreaterThan(severityRank("INFO"));
    expect(worstSeverity(["INFO", "CRITICAL", "WARNING"])).toBe("CRITICAL");
    expect(worstSeverity([])).toBeNull();
  });
});

describe("telemetry helpers", () => {
  const def = { nominal_min: 6, nominal_max: 8.4, limit_min: 5.5, limit_max: 8.6 };
  it("classifies range state", () => {
    expect(rangeState(7, def)).toBe("nominal");
    expect(rangeState(5.8, def)).toBe("warning");
    expect(rangeState(8.7, def)).toBe("critical");
    expect(rangeState("OK", def)).toBe("unknown");
    expect(rangeState(7, undefined)).toBe("unknown");
  });
  it("detects trend", () => {
    expect(trendOf([1, 1, 1, 1, 1, 1, 1, 1])).toBe("flat");
    expect(trendOf([1, 2, 3, 4, 5, 6, 7, 8])).toBe("up");
    expect(trendOf([8, 7, 6, 5, 4, 3, 2, 1])).toBe("down");
    expect(trendOf([1, 2])).toBe("flat");
  });
  it("formats ranges and ids", () => {
    expect(fmtRange(1, 2)).toBe("1 … 2");
    expect(fmtRange(null, 2)).toBe("−∞ … 2");
    expect(fmtRange(null, null)).toBe("—");
    expect(humanize("obc_thermal")).toBe("Obc Thermal");
  });
});

describe("formatErrorDetail", () => {
  it("handles FastAPI shapes", () => {
    expect(formatErrorDetail({ detail: "Unknown command: FOO" })).toBe("Unknown command: FOO");
    expect(formatErrorDetail({ detail: [{ loc: ["body", "parameters", "count"], msg: "must be <= 100" }] })).toBe("parameters.count: must be <= 100");
    expect(formatErrorDetail(null, "x")).toBe("x");
    expect(formatErrorDetail("plain")).toBe("plain");
  });
});

describe("trendOf with large offsets", () => {
  it("detects a slow ramp on a large baseline (e.g. uptime)", () => {
    const v = Array.from({ length: 120 }, (_, i) => 10_000 + i * 0.1);
    expect(trendOf(v)).toBe("up");
  });
  it("treats noise as flat", () => {
    const v = Array.from({ length: 200 }, (_, i) => 5 + (i % 2 ? 0.01 : -0.01));
    expect(trendOf(v)).toBe("flat");
  });
});
