// Shared live-data store: owns the four WebSocket channels, rolling buffers and REST bootstrap/polling.
// React components read immutable snapshots that are published at most every PUBLISH_INTERVAL_MS.
import { api } from "./api";
import { RingBuffer, rateFromTimes } from "./buffer";
import { LIVE_BUFFER_SIZE, PUBLISH_INTERVAL_MS, SATELLITE_ID } from "./config";
import { humanize, severityRank, toMs } from "./formatters";
import { FALLBACK_SCHEMA, schemaMap } from "./params";
import type {
  Anomaly,
  AnomalyMessage,
  ConnectionState,
  HealthHistoryItem,
  HealthUpdate,
  Mode,
  ParameterDef,
  SatelliteStatus,
  SimulationStatus,
  SubsystemId,
  SystemStatus,
  TelemetryPacket,
  TelemetryRow,
} from "./types";
import { ReconnectingSocket, WS_CHANNELS, type ChannelInfo, type WsChannel, type WsState } from "./websocket";

export interface HealthPoint {
  t: number;
  overall: number;
  anomaly: number;
  rule: number | null;
  mahalanobis: number | null;
  isolation_forest: number | null;
  lstm: number | null;
  subsystems: Partial<Record<SubsystemId, number>>;
}

export type LiveEventKind = "anomaly" | "simulation" | "system" | "health" | "replay";

export interface LiveEvent {
  id: number;
  t: number; // epoch ms (event time)
  kind: LiveEventKind;
  severity?: string;
  text: string;
  href?: string;
}

export type BackendState = "ONLINE" | "OFFLINE" | "UNKNOWN";

export interface LiveSnapshot {
  version: number;
  /** Increments whenever the live buffers are cleared (source switch, replay seek…). */
  epoch: number;
  telemetry: TelemetryPacket[];
  latestTelemetry: TelemetryPacket | null;
  health: HealthPoint[];
  latestHealth: HealthUpdate | null;
  anomalies: Anomaly[]; // newest first
  activeAlarms: number;
  system: SystemStatus | null;
  simulation: SimulationStatus | null;
  satStatus: SatelliteStatus | null;
  channels: Record<WsChannel, ChannelInfo>;
  backend: { state: BackendState; latencyMs: number | null; version: string | null; checkedAt: number | null };
  connection: ConnectionState;
  mode: Mode;
  events: LiveEvent[]; // newest first
  lastPacketRecvAt: number | null;
  packetRate: number;
  schema: ParameterDef[];
  schemaByName: Record<string, ParameterDef>;
  schemaLoaded: boolean;
}

const MAX_ANOMALIES = 500;

function emptyChannels(): Record<WsChannel, ChannelInfo> {
  return {
    telemetry: { state: "CLOSED", attempts: 0, lastMessageAt: null, messages: 0 },
    health: { state: "CLOSED", attempts: 0, lastMessageAt: null, messages: 0 },
    anomalies: { state: "CLOSED", attempts: 0, lastMessageAt: null, messages: 0 },
    system: { state: "CLOSED", attempts: 0, lastMessageAt: null, messages: 0 },
  };
}

const FALLBACK_BY_NAME = schemaMap(FALLBACK_SCHEMA);

export const EMPTY_SNAPSHOT: LiveSnapshot = {
  version: 0,
  epoch: 0,
  telemetry: [],
  latestTelemetry: null,
  health: [],
  latestHealth: null,
  anomalies: [],
  activeAlarms: 0,
  system: null,
  simulation: null,
  satStatus: null,
  channels: emptyChannels(),
  backend: { state: "UNKNOWN", latencyMs: null, version: null, checkedAt: null },
  connection: "DISCONNECTED",
  mode: "IDLE",
  events: [],
  lastPacketRecvAt: null,
  packetRate: 0,
  schema: FALLBACK_SCHEMA,
  schemaByName: FALLBACK_BY_NAME,
  schemaLoaded: false,
};

export function healthPointFromUpdate(h: HealthUpdate): HealthPoint {
  const subs: Partial<Record<SubsystemId, number>> = {};
  for (const s of h.subsystems ?? []) subs[s.id] = s.health_score;
  const d = h.inference?.detectors;
  return {
    t: toMs(h.timestamp),
    overall: h.overall_score,
    anomaly: h.anomaly_score,
    rule: d?.rule ?? null,
    mahalanobis: d?.mahalanobis ?? null,
    isolation_forest: d?.isolation_forest ?? null,
    lstm: d?.lstm ?? null,
    subsystems: subs,
  };
}

export function healthPointFromHistory(h: HealthHistoryItem): HealthPoint {
  return {
    t: toMs(h.timestamp),
    overall: h.overall_score,
    anomaly: h.anomaly_score,
    rule: h.detectors?.rule ?? null,
    mahalanobis: h.detectors?.mahalanobis ?? null,
    isolation_forest: h.detectors?.isolation_forest ?? null,
    lstm: h.detectors?.lstm ?? null,
    subsystems: h.subsystems ?? {},
  };
}

export function rowToPacket(r: TelemetryRow): TelemetryPacket {
  return { type: "telemetry", satellite_id: SATELLITE_ID, ...r };
}

/** Derive the top-bar connection state from transport + backend state. */
export function deriveConnection(
  backend: BackendState,
  channels: Record<WsChannel, ChannelInfo>,
  sat: SatelliteStatus | null,
): ConnectionState {
  if (backend === "OFFLINE") return "DISCONNECTED";
  const states = Object.values(channels).map((c) => c.state);
  if (states.every((s) => s !== "OPEN")) return backend === "ONLINE" ? "DEGRADED" : "DISCONNECTED";
  if (states.some((s) => s !== "OPEN")) return "DEGRADED";
  return sat?.connection ?? "CONNECTED";
}

type Listener = () => void;

export class LiveStore {
  private telemetry = new RingBuffer<TelemetryPacket>(LIVE_BUFFER_SIZE);
  private recvTimes = new RingBuffer<number>(600);
  private health = new RingBuffer<HealthPoint>(LIVE_BUFFER_SIZE);
  private events = new RingBuffer<LiveEvent>(150);
  private anomalies = new Map<string, Anomaly>();
  private latestHealth: HealthUpdate | null = null;
  private system: SystemStatus | null = null;
  private simulation: SimulationStatus | null = null;
  private satStatus: SatelliteStatus | null = null;
  private channels = emptyChannels();
  private backend: LiveSnapshot["backend"] = { ...EMPTY_SNAPSHOT.backend };
  private lastPacketRecvAt: number | null = null;
  private schema: ParameterDef[] = FALLBACK_SCHEMA;
  private schemaLoaded = false;
  private schemaByName: Record<string, ParameterDef> = FALLBACK_BY_NAME;
  private epoch = 0;
  private eventSeq = 0;

  private sockets: Partial<Record<WsChannel, ReconnectingSocket>> = {};
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<Listener>();
  private dirty = true;
  private snapshot: LiveSnapshot = EMPTY_SNAPSHOT;
  private started = false;
  private bootstrapping = false;

  // ------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const ch of WS_CHANNELS) {
      const sock = ReconnectingSocket.forChannel(ch, {
        onMessage: (m) => this.onMessage(ch, m),
        onStateChange: (s) => this.onSocketState(ch, s, sock),
      });
      this.sockets[ch] = sock;
      sock.connect();
    }
    this.timers.push(setInterval(() => this.publish(), PUBLISH_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.pollBackend(), 5000));
    this.timers.push(setInterval(() => this.markDirty(), 1000)); // keeps packet-rate/ages fresh
    void this.pollBackend();
  }

  stop(): void {
    this.started = false;
    for (const s of Object.values(this.sockets)) s?.close();
    this.sockets = {};
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): LiveSnapshot => this.snapshot;

  getServerSnapshot = (): LiveSnapshot => EMPTY_SNAPSHOT;

  private markDirty(): void {
    this.dirty = true;
  }

  private publish(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const now = Date.now();
    const anomalies = Array.from(this.anomalies.values()).sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));
    const channels = {
      telemetry: { ...this.channels.telemetry },
      health: { ...this.channels.health },
      anomalies: { ...this.channels.anomalies },
      system: { ...this.channels.system },
    };
    const mode: Mode = this.simulation?.mode ?? this.system?.simulator.mode ?? this.satStatus?.mode ?? "IDLE";
    this.snapshot = {
      version: this.snapshot.version + 1,
      epoch: this.epoch,
      telemetry: this.telemetry.toArray(),
      latestTelemetry: this.telemetry.last() ?? null,
      health: this.health.toArray(),
      latestHealth: this.latestHealth,
      anomalies,
      activeAlarms: anomalies.filter((a) => a.status === "ACTIVE").length,
      system: this.system,
      simulation: this.simulation,
      satStatus: this.satStatus,
      channels,
      backend: { ...this.backend },
      connection: deriveConnection(this.backend.state, channels, this.satStatus),
      mode,
      events: this.events.toArray().reverse(),
      lastPacketRecvAt: this.lastPacketRecvAt,
      packetRate: rateFromTimes(this.recvTimes.toArray(), now, 5000),
      schema: this.schema,
      schemaByName: this.schemaByName,
      schemaLoaded: this.schemaLoaded,
    };
    for (const l of this.listeners) l();
  }

  private addEvent(e: Omit<LiveEvent, "id">): void {
    this.events.push({ ...e, id: ++this.eventSeq });
  }

  // ------------------------------------------------------------ sockets

  private onSocketState(ch: WsChannel, s: WsState, sock: ReconnectingSocket): void {
    this.channels[ch] = { ...this.channels[ch], state: s, attempts: sock.attempts };
    this.markDirty();
  }

  private onMessage(ch: WsChannel, msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const info = this.channels[ch];
    info.lastMessageAt = Date.now();
    info.messages++;
    const type = (msg as { type?: string }).type;
    switch (type) {
      case "telemetry":
        this.ingestTelemetry(msg as TelemetryPacket);
        break;
      case "health":
        this.ingestHealth(msg as HealthUpdate);
        break;
      case "anomaly":
        this.ingestAnomaly(msg as AnomalyMessage);
        break;
      case "system":
        this.system = msg as SystemStatus;
        this.backend = { ...this.backend, state: "ONLINE", version: this.system.backend?.version ?? this.backend.version };
        break;
      case "simulation":
        this.setSimulation((msg as { status: SimulationStatus }).status);
        break;
      default:
        return;
    }
    this.markDirty();
  }

  /** Clear rolling buffers (stream discontinuity such as SIMULATION→REPLAY or a backwards seek). */
  resetBuffers(reason?: string): void {
    this.telemetry.clear();
    this.health.clear();
    this.epoch++;
    if (reason) this.addEvent({ t: Date.now(), kind: "system", text: reason });
    this.markDirty();
  }

  ingestTelemetry(p: TelemetryPacket): void {
    const last = this.telemetry.last();
    const t = toMs(p.timestamp);
    if (!Number.isFinite(t)) return;
    if (last) {
      const lt = toMs(last.timestamp);
      const sourceChanged = last.source !== p.source;
      const runChanged = p.source === "REPLAY" && last.run_id && p.run_id && last.run_id !== p.run_id;
      if (sourceChanged || runChanged || t < lt - 1000) {
        this.resetBuffers(sourceChanged ? `Telemetry source changed ${last.source} → ${p.source}` : undefined);
      } else if (t <= lt && p.sequence === last.sequence) {
        return; // duplicate
      }
    }
    this.telemetry.push(p);
    const now = Date.now();
    this.recvTimes.push(now);
    this.lastPacketRecvAt = now;
  }

  ingestHealth(h: HealthUpdate): void {
    const pt = healthPointFromUpdate(h);
    if (!Number.isFinite(pt.t)) return;
    const last = this.health.last();
    if (last && pt.t < last.t - 1000) this.health.clear();
    if (!last || pt.t !== last.t) this.health.push(pt);
    const prev = this.latestHealth;
    if (prev && prev.status !== h.status) {
      this.addEvent({
        t: pt.t,
        kind: "health",
        severity: h.status,
        text: `Overall health ${prev.status} → ${h.status} (${h.overall_score.toFixed(0)})`,
      });
    }
    this.latestHealth = h;
  }

  ingestAnomaly(m: AnomalyMessage): void {
    const a = m.anomaly;
    if (!a?.id) return;
    this.upsertAnomaly(a);
    const href = `/anomalies/${encodeURIComponent(a.id)}`;
    const subs = a.subsystems.join("/");
    const t = m.event === "created" || m.event === "replay" ? toMs(a.timestamp) : Date.now();
    switch (m.event) {
      case "created":
        this.addEvent({ t, kind: "anomaly", severity: a.severity, text: a.description || `${a.severity} anomaly ${subs}`, href });
        break;
      case "acknowledged":
        this.addEvent({ t, kind: "anomaly", severity: "INFO", text: `Anomaly ${subs} acknowledged by ${a.acknowledged_by ?? "?"}`, href });
        break;
      case "resolved":
        this.addEvent({ t, kind: "anomaly", severity: "INFO", text: `Anomaly ${subs} resolved by ${a.resolved_by ?? "?"}`, href });
        break;
      case "replay":
        this.addEvent({ t, kind: "replay", severity: a.severity, text: `Replay: ${a.description || `${a.severity} ${subs}`}`, href });
        break;
      default:
        break; // "updated" – too chatty for the timeline
    }
  }

  upsertAnomaly(a: Anomaly): void {
    this.anomalies.set(a.id, a);
    if (this.anomalies.size > MAX_ANOMALIES) {
      const sorted = Array.from(this.anomalies.values()).sort((x, y) => toMs(x.timestamp) - toMs(y.timestamp));
      for (const old of sorted) {
        if (this.anomalies.size <= MAX_ANOMALIES) break;
        if (old.status !== "ACTIVE") this.anomalies.delete(old.id);
      }
    }
    this.markDirty();
    this.publish(true);
  }

  setSimulation(s: SimulationStatus | null): void {
    if (!s) return;
    const prev = this.simulation;
    if (prev) {
      const t = Date.now();
      if (prev.mode !== s.mode) this.addEvent({ t, kind: "simulation", text: `Mode ${prev.mode} → ${s.mode}` });
      else if (prev.running !== s.running) this.addEvent({ t, kind: "simulation", text: s.running ? "Simulation started" : "Simulation stopped" });
      else if (prev.paused !== s.paused) this.addEvent({ t, kind: "simulation", text: s.paused ? "Simulation paused" : "Simulation resumed" });
      if (prev.speed !== s.speed) this.addEvent({ t, kind: "simulation", text: `Speed ${prev.speed}× → ${s.speed}×` });
      const prevIds = new Set(prev.active_faults.map((f) => f.id));
      for (const f of s.active_faults) {
        if (!prevIds.has(f.id))
          this.addEvent({ t, kind: "simulation", severity: "WARNING", text: `Fault injected: ${humanize(f.scenario)} (${f.severity})` });
      }
      if (prev.active_faults.length && !s.active_faults.length) this.addEvent({ t, kind: "simulation", text: "All faults cleared" });
      if (s.replay && prev.replay && toMs(s.replay.position) < toMs(prev.replay.position) - 1000) {
        this.resetBuffers();
      }
    }
    this.simulation = s;
    this.markDirty();
    this.publish(true);
  }

  // ------------------------------------------------------------ REST

  private async pollBackend(): Promise<void> {
    const t0 = performance.now();
    const wasOnline = this.backend.state === "ONLINE";
    try {
      const h = await api.health();
      this.backend = { state: "ONLINE", latencyMs: performance.now() - t0, version: h?.version ?? null, checkedAt: Date.now() };
      if (!wasOnline || !this.schemaLoaded) {
        for (const s of Object.values(this.sockets)) s?.reconnectNow();
        void this.bootstrap();
      }
      void api
        .satelliteStatus()
        .then((s) => {
          this.satStatus = s;
          this.markDirty();
        })
        .catch(() => undefined);
      if (this.channels.system.state !== "OPEN") {
        void api
          .systemStatus()
          .then((s) => {
            this.system = s;
            this.markDirty();
          })
          .catch(() => undefined);
        void api
          .simStatus()
          .then((s) => this.setSimulation(s))
          .catch(() => undefined);
      }
    } catch {
      this.backend = { ...this.backend, state: "OFFLINE", latencyMs: null, checkedAt: Date.now() };
      if (wasOnline) this.addEvent({ t: Date.now(), kind: "system", severity: "CRITICAL", text: "Backend unreachable" });
    }
    this.markDirty();
  }

  /** Load initial state over REST (schema, anomalies, sim/system status, recent history). */
  async bootstrap(): Promise<void> {
    if (this.bootstrapping) return;
    this.bootstrapping = true;
    try {
      const [schema, anomalies, active, sim, sys, hist, tele] = await Promise.allSettled([
        this.schemaLoaded ? Promise.resolve(this.schema) : api.schema(),
        api.anomalies({ limit: 200 }),
        api.anomalies({ status: "ACTIVE", limit: 200 }),
        api.simStatus(),
        api.systemStatus(),
        // no `start`: the backend defaults to its latest 10 minutes (packet time may be simulated, not wall clock)
        this.health.size ? Promise.resolve(null) : api.healthHistory({ max_points: 1200 }),
        this.telemetry.size
          ? Promise.resolve(null)
          : api.history({ max_points: 3000, limit: 5000 }),
      ]);
      if (schema.status === "fulfilled" && Array.isArray(schema.value) && schema.value.length) {
        if (!this.schemaLoaded) {
          this.schema = schema.value;
          this.schemaByName = schemaMap(schema.value);
          this.schemaLoaded = true;
        }
      }
      const seedTimeline = this.anomalies.size === 0 && this.events.size === 0;
      for (const r of [anomalies, active]) {
        if (r.status === "fulfilled" && Array.isArray(r.value)) for (const a of r.value) this.anomalies.set(a.id, a);
      }
      if (seedTimeline) {
        const recent = Array.from(this.anomalies.values())
          .sort((x, y) => toMs(x.timestamp) - toMs(y.timestamp))
          .slice(-15);
        for (const a of recent) {
          this.addEvent({
            t: toMs(a.timestamp),
            kind: "anomaly",
            severity: a.severity,
            text: a.description || `${a.severity} anomaly ${a.subsystems.join("/")}`,
            href: `/anomalies/${encodeURIComponent(a.id)}`,
          });
        }
      }
      if (sim.status === "fulfilled" && sim.value) this.setSimulation(sim.value);
      if (sys.status === "fulfilled" && sys.value) this.system = sys.value;
      if (hist.status === "fulfilled" && hist.value?.items?.length) {
        const pts = hist.value.items.map(healthPointFromHistory).filter((p) => Number.isFinite(p.t));
        const first = this.health.first();
        const existing = this.health.toArray();
        this.health.clear();
        this.health.pushMany(first ? pts.filter((p) => p.t < first.t) : pts);
        this.health.pushMany(existing);
      }
      if (tele.status === "fulfilled" && tele.value?.items?.length) {
        const rows = tele.value.items.map(rowToPacket);
        const first = this.telemetry.first();
        const existing = this.telemetry.toArray();
        const src = first?.source;
        this.telemetry.clear();
        this.telemetry.pushMany(
          first ? rows.filter((r) => toMs(r.timestamp) < toMs(first.timestamp) && r.source === src) : rows,
        );
        this.telemetry.pushMany(existing);
      }
    } finally {
      this.bootstrapping = false;
      this.markDirty();
      this.publish(true);
    }
  }

  /** Re-fetch anomalies from REST (e.g. after reconnect). */
  async refreshAnomalies(): Promise<void> {
    try {
      const list = await api.anomalies({ limit: 200 });
      for (const a of list) this.anomalies.set(a.id, a);
      this.markDirty();
    } catch {
      /* offline */
    }
  }
}

/** Highest severity among currently active anomalies, or null. */
export function worstActiveSeverity(anomalies: Anomaly[]): Anomaly["severity"] | null {
  let worst: Anomaly["severity"] | null = null;
  for (const a of anomalies) {
    if (a.status !== "ACTIVE") continue;
    if (!worst || severityRank(a.severity) > severityRank(worst)) worst = a.severity;
  }
  return worst;
}
