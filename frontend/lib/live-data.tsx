"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { getOperator, loadOperator, setOperator as persistOperator } from "./api";
import { EMPTY_SNAPSHOT, LiveStore, type LiveSnapshot } from "./live-store";

interface LiveContextValue {
  store: LiveStore | null;
  operator: string;
  setOperator: (name: string) => void;
}

const LiveContext = createContext<LiveContextValue>({ store: null, operator: "operator", setOperator: () => undefined });

const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

/** Single shared live-data layer: one set of WebSockets for the whole app. */
export function LiveDataProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<LiveStore | null>(null);
  const [operator, setOperatorState] = useState("operator");

  useEffect(() => {
    setOperatorState(loadOperator());
    const s = new LiveStore();
    s.start();
    setStore(s);
    return () => s.stop();
  }, []);

  const setOperator = useCallback((name: string) => {
    persistOperator(name);
    setOperatorState(getOperator());
  }, []);

  const value = useMemo(() => ({ store, operator, setOperator }), [store, operator, setOperator]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** Throttled (≤4 Hz) immutable snapshot of all live data. */
export function useLive(): LiveSnapshot {
  const { store } = useContext(LiveContext);
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : emptySnapshot, emptySnapshot);
}

/** Access to the store for imperative updates (e.g. apply a REST response immediately). */
export function useLiveStore(): LiveStore | null {
  return useContext(LiveContext).store;
}

export function useOperator(): [string, (name: string) => void] {
  const { operator, setOperator } = useContext(LiveContext);
  return [operator, setOperator];
}
