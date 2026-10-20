"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

/** Current epoch ms, re-rendering every `intervalMs`. Returns 0 during SSR / first paint. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Fetch helper: runs `fn` on mount and whenever `deps` change; optional polling.
 * Errors are captured as strings (never thrown) so pages degrade gracefully when the backend is down.
 */
export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], opts: { intervalMs?: number; enabled?: boolean } = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;
    const run = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const d = await fnRef.current(ctrl.signal);
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && !ctrl.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run(true);
    const id = opts.intervalMs ? setInterval(() => void run(false), opts.intervalMs) : null;
    return () => {
      cancelled = true;
      ctrl.abort();
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled, opts.intervalMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Wraps an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
