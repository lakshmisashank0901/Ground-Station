import { describe, expect, it } from "vitest";
import { backoffDelay, downsampleMinMax, lowerBound, mergeBackfill, rateFromTimes, RingBuffer, sliceByTime, strideSample } from "@/lib/buffer";

describe("RingBuffer", () => {
  it("keeps the newest N in order", () => {
    const b = new RingBuffer<number>(3);
    expect(b.toArray()).toEqual([]);
    expect(b.last()).toBeUndefined();
    b.pushMany([1, 2]);
    expect(b.toArray()).toEqual([1, 2]);
    b.pushMany([3, 4, 5]);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.first()).toBe(3);
    expect(b.last()).toBe(5);
    expect(b.size).toBe(3);
    b.clear();
    expect(b.size).toBe(0);
  });
  it("rejects zero capacity", () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe("time slicing", () => {
  const arr = [10, 20, 30, 40, 50].map((t) => ({ t }));
  it("binary searches", () => {
    expect(lowerBound(arr, 25, (x) => x.t)).toBe(2);
    expect(lowerBound(arr, 5, (x) => x.t)).toBe(0);
    expect(lowerBound(arr, 99, (x) => x.t)).toBe(5);
  });
  it("slices inclusive range", () => {
    expect(sliceByTime(arr, 20, 40, (x) => x.t).map((x) => x.t)).toEqual([20, 30, 40]);
    expect(sliceByTime(arr, 41, 45, (x) => x.t)).toEqual([]);
  });
});

describe("downsampling", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i === 500 ? 999 : Math.sin(i / 10) }));
  it("bounds the output and keeps endpoints + spikes", () => {
    const out = downsampleMinMax(pts, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[999]);
    expect(out.some((p) => p.v === 999)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
  });
  it("returns a copy when already small", () => {
    const small = pts.slice(0, 10);
    expect(downsampleMinMax(small, 100)).toEqual(small);
  });
  it("stride sampling keeps first and last", () => {
    const s = strideSample(pts, 11);
    expect(s.length).toBe(11);
    expect(s[0]).toBe(pts[0]);
    expect(s[10]).toBe(pts[999]);
  });
});

describe("mergeBackfill", () => {
  it("drops overlapping history and appends live", () => {
    const hist = [1, 2, 3, 4].map((t) => ({ t, src: "h" }));
    const live = [3, 4, 5].map((t) => ({ t, src: "l" }));
    expect(mergeBackfill(hist, live).map((p) => `${p.src}${p.t}`)).toEqual(["h1", "h2", "l3", "l4", "l5"]);
    expect(mergeBackfill(hist, [])).toEqual(hist);
  });
});

describe("rates & backoff", () => {
  it("computes packet rate over a window", () => {
    const now = 100_000;
    const times = Array.from({ length: 50 }, (_, i) => now - 9_800 + i * 200); // 50 packets in 10 s
    expect(rateFromTimes(times, now, 10_000)).toBeCloseTo(5);
    expect(rateFromTimes([], now)).toBe(0);
  });
  it("backs off exponentially with a cap", () => {
    expect(backoffDelay(0, 500, 15_000)).toBe(500);
    expect(backoffDelay(3, 500, 15_000)).toBe(4000);
    expect(backoffDelay(20, 500, 15_000)).toBe(15_000);
    const j = backoffDelay(2, 1000, 60_000, 0.5, () => 0);
    expect(j).toBe(2000);
  });
});
