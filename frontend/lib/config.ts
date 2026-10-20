// Runtime endpoints. NEXT_PUBLIC_* are inlined at build time.
function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function deriveWsUrl(apiUrl: string): string {
  return stripSlash(apiUrl).replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

export const API_URL = stripSlash(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000");
export const WS_URL = stripSlash(process.env.NEXT_PUBLIC_WS_URL || deriveWsUrl(API_URL));
export const API_BASE = `${API_URL}/api/v1`;

export const SATELLITE_ID = "SAT-01";
/** Rolling in-memory telemetry/health buffer size (packets). */
export const LIVE_BUFFER_SIZE = 3600;
/** Max UI publish rate for live data (ms between snapshots → 4 Hz). */
export const PUBLISH_INTERVAL_MS = 250;
