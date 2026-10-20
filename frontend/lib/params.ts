import type { ParameterDef, SubsystemId, SubsystemName } from "./types";

type P = [name: string, label: string, unit: string, subsystem: SubsystemName, type: ParameterDef["type"], enumValues?: string[]];

// Static fallback derived from the contract table (docs/API.md §2). Used until /telemetry/schema loads,
// or when the backend is unreachable. Ranges are unknown here (null) – the live schema supplies them.
const RAW: P[] = [
  ["battery_voltage", "Battery Voltage", "V", "EPS", "float"],
  ["battery_current", "Battery Current", "A", "EPS", "float"],
  ["battery_temperature", "Battery Temperature", "°C", "EPS", "float"],
  ["bus_voltage", "Bus Voltage", "V", "EPS", "float"],
  ["bus_current", "Bus Current", "A", "EPS", "float"],
  ["power_consumption", "Power Consumption", "W", "EPS", "float"],
  ["solar_input_power", "Solar Input Power", "W", "EPS", "float"],
  ["battery_soc", "Battery SOC", "%", "EPS", "float"],
  ["obc_temperature", "OBC Temperature", "°C", "OBC", "float"],
  ["cpu_load", "CPU Load", "%", "OBC", "float"],
  ["memory_usage", "Memory Usage", "%", "OBC", "float"],
  ["watchdog_status", "Watchdog", "", "OBC", "enum", ["OK", "FAULT"]],
  ["obc_uptime", "OBC Uptime", "s", "OBC", "int"],
  ["roll", "Roll", "deg", "ADCS", "float"],
  ["pitch", "Pitch", "deg", "ADCS", "float"],
  ["yaw", "Yaw", "deg", "ADCS", "float"],
  ["gyro_x", "Gyro X", "deg/s", "ADCS", "float"],
  ["gyro_y", "Gyro Y", "deg/s", "ADCS", "float"],
  ["gyro_z", "Gyro Z", "deg/s", "ADCS", "float"],
  ["rssi", "RSSI", "dBm", "COMM", "float"],
  ["snr", "SNR", "dB", "COMM", "float"],
  ["packet_loss", "Packet Loss", "%", "COMM", "float"],
  ["crc_errors", "CRC Errors", "count", "COMM", "int"],
  ["payload_temperature", "Payload Temperature", "°C", "PAYLOAD", "float"],
  ["payload_power", "Payload Power", "W", "PAYLOAD", "float"],
  ["payload_state", "Payload State", "", "PAYLOAD", "enum", ["IDLE", "ACTIVE", "SAFE"]],
];

export const FALLBACK_SCHEMA: ParameterDef[] = RAW.map(([name, label, unit, subsystem, type, enumValues]) => ({
  name,
  label,
  unit,
  subsystem,
  type,
  nominal_min: null,
  nominal_max: null,
  limit_min: null,
  limit_max: null,
  ...(enumValues ? { enum_values: enumValues } : {}),
  description: "",
}));

export const SUBSYSTEM_IDS: SubsystemId[] = ["eps", "obc", "adcs", "comm", "payload"];

export const SUBSYSTEM_NAMES: Record<SubsystemId, SubsystemName> = {
  eps: "EPS",
  obc: "OBC",
  adcs: "ADCS",
  comm: "COMM",
  payload: "PAYLOAD",
};

export const SUBSYSTEM_TITLES: Record<SubsystemId, string> = {
  eps: "Electrical Power",
  obc: "On-Board Computer",
  adcs: "Attitude Determination & Control",
  comm: "Communications",
  payload: "Payload",
};

export function subsystemIdFromName(name: string): SubsystemId | null {
  const n = name.toLowerCase();
  return (SUBSYSTEM_IDS as string[]).includes(n) ? (n as SubsystemId) : null;
}

/** Parameters shown on each subsystem health card (spec 4.4). */
export const CARD_PARAMS: Record<SubsystemId, string[]> = {
  eps: ["battery_voltage", "battery_current", "power_consumption", "battery_temperature", "battery_soc"],
  obc: ["obc_temperature", "cpu_load", "memory_usage", "watchdog_status", "obc_uptime"],
  adcs: ["roll", "pitch", "yaw", "gyro_x", "gyro_y", "gyro_z"],
  comm: ["rssi", "snr", "packet_loss", "crc_errors"],
  payload: ["payload_temperature", "payload_power", "payload_state"],
};

/** Short labels for dense health cards. */
export const SHORT_LABELS: Record<string, string> = {
  battery_voltage: "Voltage",
  battery_current: "Current",
  power_consumption: "Power",
  battery_temperature: "Batt temp",
  battery_soc: "SOC",
  obc_temperature: "Temp",
  cpu_load: "CPU",
  memory_usage: "Memory",
  watchdog_status: "Watchdog",
  obc_uptime: "Uptime",
  roll: "Roll",
  pitch: "Pitch",
  yaw: "Yaw",
  gyro_x: "Gyro X",
  gyro_y: "Gyro Y",
  gyro_z: "Gyro Z",
  rssi: "RSSI",
  snr: "SNR",
  packet_loss: "Pkt loss",
  crc_errors: "CRC err",
  payload_temperature: "Temp",
  payload_power: "Power",
  payload_state: "State",
};

export interface ParamGroup {
  id: string;
  label: string;
  params: string[];
}

/** Telemetry page grouping (demo script: electrical, thermal, attitude, communication, payload). */
export const TELEMETRY_GROUPS: ParamGroup[] = [
  {
    id: "electrical",
    label: "Electrical",
    params: ["battery_voltage", "battery_current", "bus_voltage", "bus_current", "power_consumption", "solar_input_power", "battery_soc"],
  },
  { id: "thermal", label: "Thermal", params: ["battery_temperature", "obc_temperature", "payload_temperature"] },
  { id: "attitude", label: "Attitude", params: ["roll", "pitch", "yaw", "gyro_x", "gyro_y", "gyro_z"] },
  { id: "communication", label: "Communication", params: ["rssi", "snr", "packet_loss", "crc_errors"] },
  { id: "payload", label: "Payload", params: ["payload_temperature", "payload_power", "payload_state"] },
  { id: "computing", label: "Computing", params: ["cpu_load", "memory_usage", "watchdog_status", "obc_uptime"] },
];

/** Key parameters charted live on the dashboard. */
export const DASHBOARD_CHART_PARAMS = ["battery_voltage", "obc_temperature", "cpu_load", "rssi"];

export function schemaMap(schema: ParameterDef[]): Record<string, ParameterDef> {
  const m: Record<string, ParameterDef> = {};
  for (const p of schema) m[p.name] = p;
  return m;
}
