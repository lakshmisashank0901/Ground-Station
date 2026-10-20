// Auto-reconnecting WebSocket channel with exponential backoff and a keep-alive ping.
import { backoffDelay } from "./buffer";
import { WS_URL } from "./config";

export type WsChannel = "telemetry" | "health" | "anomalies" | "system";
export const WS_CHANNELS: WsChannel[] = ["telemetry", "health", "anomalies", "system"];

export type WsState = "CONNECTING" | "OPEN" | "CLOSED";

export interface ChannelInfo {
  state: WsState;
  attempts: number;
  lastMessageAt: number | null;
  messages: number;
}

interface Options {
  onMessage: (data: unknown) => void;
  onStateChange?: (state: WsState) => void;
  pingIntervalMs?: number;
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  attempts = 0;
  state: WsState = "CLOSED";

  constructor(
    readonly url: string,
    private readonly opts: Options,
  ) {}

  static forChannel(channel: WsChannel, opts: Options): ReconnectingSocket {
    return new ReconnectingSocket(`${WS_URL}/ws/${channel}`, opts);
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private setState(s: WsState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private open(): void {
    if (this.closedByUser) return;
    this.setState("CONNECTING");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setState("OPEN");
      this.startPing();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "pong") return;
      this.opts.onMessage(parsed);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      this.setState("CLOSED");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.retryTimer) return;
    const delay = backoffDelay(this.attempts++, 500, 15_000, 0.2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const every = this.opts.pingIntervalMs ?? 20_000;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send("ping");
        } catch {
          /* ignore */
        }
      }
    }, every);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Force an immediate reconnect attempt (e.g. after the backend comes back). */
  reconnectNow(): void {
    if (this.state === "OPEN" || this.closedByUser) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.state === "CONNECTING" && this.ws) return;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.setState("CLOSED");
  }
}
