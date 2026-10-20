// Pure data-structure helpers for the live data layer and charts. Unit tested in tests/buffer.test.ts.

/** Fixed-capacity FIFO ring buffer. push is O(1); toArray returns oldest → newest. */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private start = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.buf = new Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  push(item: T): void {
    if (this.len < this.capacity) {
      this.buf[(this.start + this.len) % this.capacity] = item;
      this.len++;
    } else {
      this.buf[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  pushMany(items: Iterable<T>): void {
    for (const it of items) this.push(it);
  }

  /** Oldest item, or undefined. */
  first(): T | undefined {
    return this.len ? this.buf[this.start] : undefined;
  }

  /** Newest item, or undefined. */
  last(): T | undefined {
    return this.len ? this.buf[(this.start + this.len - 1) % this.capacity] : undefined;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.start = 0;
    this.len = 0;
  }

  toArray(): T[] {
    const out = new Array<T>(this.len);
    for (let i = 0; i < this.len; i++) out[i] = this.buf[(this.start + i) % this.capacity] as T;
    return out;
  }
}

/** Index of the first element with key(x) >= t in an ascending array (binary search). */
export function lowerBound<T>(arr: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Slice of an ascending array where start <= key(x) <= end. */
export function sliceByTime<T>(arr: readonly T[], start: number, end: number, key: (x: T) => number): T[] {
  const i = lowerBound(arr, start, key);
  const j = lowerBound(arr, end + 1e-9, key);
  return arr.slice(i, j);
}

export interface XY {
  t: number;
  v: number | null;
}

/**
 * Min/max bucket downsampling that keeps spikes visible: each bucket contributes its min and max
 * (in time order). First and last points are always kept. Nulls are preserved as gaps only when a
 * bucket is entirely null.
 */
export function downsampleMinMax<T extends XY>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints || maxPoints < 4) return points.slice();
  const buckets = Math.floor((maxPoints - 2) / 2);
  const inner = points.length - 2;
  const size = inner / buckets;
  const out: T[] = [points[0]];
  for (let b = 0; b < buckets; b++) {
    const from = 1 + Math.floor(b * size);
    const to = Math.min(points.length - 1, 1 + Math.floor((b + 1) * size));
    let minI = -1;
    let maxI = -1;
    for (let i = from; i < to; i++) {
      const v = points[i].v;
      if (v === null) continue;
      if (minI < 0 || v < (points[minI].v as number)) minI = i;
      if (maxI < 0 || v > (points[maxI].v as number)) maxI = i;
    }
    if (minI < 0) {
      if (from < to) out.push(points[from]);
      continue;
    }
    if (minI === maxI) out.push(points[minI]);
    else if (minI < maxI) out.push(points[minI], points[maxI]);
    else out.push(points[maxI], points[minI]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Evenly pick at most n items (always includes first and last). */
export function strideSample<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n || n < 2) return arr.slice();
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/**
 * Merge an older backfill series with newer live points: backfill points at or after the first live
 * timestamp are dropped so the live buffer wins where they overlap.
 */
export function mergeBackfill<T extends { t: number }>(backfill: readonly T[], live: readonly T[]): T[] {
  if (!live.length) return backfill.slice();
  const cut = live[0].t;
  const older = backfill.filter((p) => p.t < cut);
  return older.concat(live);
}

/** Packet rate (per second) from receive timestamps (ms), over the trailing window. */
export function rateFromTimes(times: readonly number[], now: number, windowMs = 10_000): number {
  const since = now - windowMs;
  let n = 0;
  for (let i = times.length - 1; i >= 0 && times[i] >= since; i--) n++;
  return n / (windowMs / 1000);
}

/** Exponential reconnect backoff with cap and optional jitter (0..1 fraction). */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000, jitter = 0, rand: () => number = Math.random): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  if (!jitter) return raw;
  const j = raw * jitter;
  return Math.max(0, Math.round(raw - j + rand() * 2 * j));
}
