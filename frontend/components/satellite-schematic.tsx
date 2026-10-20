"use client";

import { useRouter } from "next/navigation";
import { fmtNum, isNum, toneColor, TONE_COLORS } from "@/lib/formatters";
import type { HealthStatus, SubsystemHealth, SubsystemId, TelemetryValue } from "@/lib/types";

interface NodeDef {
  id: SubsystemId;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: (d: Record<string, TelemetryValue>) => string[];
}

const ROW1 = 60;
const ROW2 = 178;
const NODE_H = 72;
const BUS_Y = 155;

const v = (x: TelemetryValue | undefined, unit: string, digits?: number) => (isNum(x) ? `${fmtNum(x, digits)}${unit}` : "—");

const NODES: NodeDef[] = [
  { id: "eps", label: "EPS", x: 155, y: ROW1, w: 105, h: NODE_H, lines: (d) => [`BUS ${v(d.bus_voltage, "V", 2)}`, `PWR ${v(d.power_consumption, "W", 1)}`] },
  { id: "obc", label: "OBC", x: 275, y: ROW1, w: 105, h: NODE_H, lines: (d) => [`T ${v(d.obc_temperature, "°C", 1)}`, `CPU ${v(d.cpu_load, "%", 0)}`] },
  { id: "comm", label: "COMM", x: 395, y: ROW1, w: 95, h: NODE_H, lines: (d) => [`${v(d.rssi, "dBm", 0)}`, `SNR ${v(d.snr, "dB", 1)}`] },
  { id: "adcs", label: "ADCS", x: 275, y: ROW2, w: 105, h: NODE_H, lines: (d) => [`R ${v(d.roll, "°", 1)} P ${v(d.pitch, "°", 1)}`, `Y ${v(d.yaw, "°", 1)}`] },
  { id: "payload", label: "PAYLOAD", x: 395, y: ROW2, w: 95, h: NODE_H, lines: (d) => [String(d.payload_state ?? "—"), `${v(d.payload_power, "W", 1)}`] },
];

function SolarArray({ x, power, side }: { x: number; power: TelemetryValue | undefined; side: "L" | "R" }) {
  const active = isNum(power) && power > 0.5;
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) cells.push(<rect key={`${r}${c}`} x={x + 4 + c * 24} y={118 + r * 25} width={21} height={22} fill={active ? "#123a6b" : "#141c28"} stroke="#2d4f7c" strokeWidth={0.8} />);
  return (
    <g aria-hidden>
      <rect x={x} y={114} width={102} height={82} fill="none" stroke="#2a3544" />
      {cells}
      <text x={x + 51} y={108} textAnchor="middle" fontSize={9} fill="#66748a" fontFamily="var(--font-mono)">
        SOLAR {side}
      </text>
    </g>
  );
}

export function SatelliteSchematic({ subsystems, data }: { subsystems: SubsystemHealth[]; data: Record<string, TelemetryValue> | undefined }) {
  const router = useRouter();
  const d = data ?? {};
  const statusOf = (id: SubsystemId): HealthStatus => subsystems.find((s) => s.id === id)?.status ?? "UNKNOWN";
  const scoreOf = (id: SubsystemId) => subsystems.find((s) => s.id === id)?.health_score;
  const solar = d.solar_input_power;
  const solarOn = isNum(solar) && solar > 0.5;
  const current = d.battery_current;
  const charging = isNum(current) && current > 0.02;
  const soc = isNum(d.battery_soc) ? Math.max(0, Math.min(100, d.battery_soc)) : null;
  const epsColor = toneColor(statusOf("eps"));
  const busColor = solarOn || charging ? "#f5b014" : "#3b4757";

  const go = (id: SubsystemId) => router.push(`/subsystems/${id}`);

  return (
    <svg viewBox="0 0 640 290" className="h-auto w-full select-none" role="img" aria-label="Satellite subsystem schematic">
      <defs>
        <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" stroke="#111822" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="640" height="290" fill="url(#grid)" />

      {/* spacecraft body */}
      <rect x={140} y={40} width={360} height={226} rx={4} fill="#0a0e14" stroke="#2a3544" strokeDasharray="5 4" />
      <text x={148} y={34} fontSize={9} fill="#66748a" fontFamily="var(--font-mono)" letterSpacing="2">
        SAT-01 · BUS
      </text>

      {/* solar arrays + arms (solar/power input) */}
      <SolarArray x={10} power={solar} side="L" />
      <SolarArray x={528} power={solar} side="R" />
      <line x1={112} y1={BUS_Y} x2={140} y2={BUS_Y} stroke={solarOn ? "#f5b014" : "#3b4757"} strokeWidth={2} className={solarOn ? "flow" : undefined} />
      <line x1={528} y1={BUS_Y} x2={500} y2={BUS_Y} stroke={solarOn ? "#f5b014" : "#3b4757"} strokeWidth={2} className={solarOn ? "flow" : undefined} />
      <text x={320} y={284} textAnchor="middle" fontSize={10} fill={solarOn ? "#f5b014" : "#66748a"} fontFamily="var(--font-mono)">
        SOLAR INPUT {v(solar, " W", 1)} · {solarOn ? "SUNLIT" : "ECLIPSE / NO INPUT"}
      </text>

      {/* main power bus */}
      <line x1={140} y1={BUS_Y} x2={500} y2={BUS_Y} stroke={busColor} strokeWidth={2.5} className={solarOn || charging ? "flow" : undefined} />
      <text x={146} y={BUS_Y - 4} fontSize={8} fill="#66748a" fontFamily="var(--font-mono)">
        PWR BUS {v(d.bus_voltage, "V", 2)} / {v(d.bus_current, "A", 2)}
      </text>
      {/* stubs from bus to each node */}
      {[...NODES.map((n) => ({ x: n.x + n.w / 2, top: n.y === ROW1 })), { x: 207.5, top: true }, { x: 207.5, top: false }].map((s, i) => (
        <line key={i} x1={s.x} y1={s.top ? ROW1 + NODE_H : BUS_Y} x2={s.x} y2={s.top ? BUS_Y : ROW2} stroke="#3b4757" strokeWidth={1.5} />
      ))}

      {/* battery (part of EPS) */}
      <g role="link" tabIndex={0} onClick={() => go("eps")} onKeyDown={(e) => e.key === "Enter" && go("eps")} style={{ cursor: "pointer" }} aria-label="Battery – open EPS">
        <rect x={155} y={ROW2} width={105} height={NODE_H} rx={3} fill={`${epsColor}12`} stroke={epsColor} strokeWidth={1.2} />
        <text x={163} y={ROW2 + 15} fontSize={10} fontWeight={700} fill="#d8dfe8" fontFamily="var(--font-mono)">
          BATTERY
        </text>
        <rect x={163} y={ROW2 + 24} width={80} height={14} rx={2} fill="none" stroke="#3b4757" />
        <rect x={243} y={ROW2 + 28} width={4} height={6} fill="#3b4757" />
        {soc !== null ? <rect x={165} y={ROW2 + 26} width={(76 * soc) / 100} height={10} fill={soc > 40 ? TONE_COLORS.nominal : soc > 20 ? TONE_COLORS.warning : TONE_COLORS.critical} opacity={0.8} /> : null}
        <text x={203} y={ROW2 + 34.5} textAnchor="middle" fontSize={8.5} fill="#06080b" fontWeight={700} fontFamily="var(--font-mono)">
          {soc !== null ? `${soc.toFixed(0)}%` : ""}
        </text>
        <text x={163} y={ROW2 + 52} fontSize={9.5} fill="#9ba8b8" fontFamily="var(--font-mono)">
          {v(d.battery_voltage, "V", 2)} {v(d.battery_temperature, "°C", 1)}
        </text>
        <text x={163} y={ROW2 + 65} fontSize={9.5} fill={charging ? TONE_COLORS.nominal : "#9ba8b8"} fontFamily="var(--font-mono)">
          {isNum(current) ? `${charging ? "CHG" : "DSG"} ${fmtNum(current, 2)}A` : "—"}
        </text>
      </g>

      {/* antenna on COMM */}
      <g aria-hidden>
        <line x1={442.5} y1={ROW1} x2={442.5} y2={22} stroke="#3b4757" strokeWidth={1.5} />
        <path d="M428 22 Q442.5 6 457 22" fill="none" stroke={toneColor(statusOf("comm"))} strokeWidth={1.5} />
        <path d="M462 12 q6 6 0 12 M468 8 q10 10 0 20" fill="none" stroke={toneColor(statusOf("comm"))} strokeWidth={1} opacity={0.6} />
      </g>

      {/* subsystem nodes */}
      {NODES.map((n) => {
        const st = statusOf(n.id);
        const c = toneColor(st);
        const score = scoreOf(n.id);
        const lines = n.lines(d);
        return (
          <g
            key={n.id}
            role="link"
            tabIndex={0}
            aria-label={`${n.label} ${st} – open details`}
            onClick={() => go(n.id)}
            onKeyDown={(e) => e.key === "Enter" && go(n.id)}
            style={{ cursor: "pointer" }}
            className="[&:hover>rect:first-child]:stroke-[2.2]"
          >
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={3} fill={`${c}14`} stroke={c} strokeWidth={1.2} />
            <circle cx={n.x + n.w - 9} cy={n.y + 10} r={3.5} fill={c} className={st === "CRITICAL" ? "blink" : undefined} />
            <text x={n.x + 8} y={n.y + 15} fontSize={10.5} fontWeight={700} fill="#d8dfe8" fontFamily="var(--font-mono)">
              {n.label}
            </text>
            <text x={n.x + 8} y={n.y + 31} fontSize={9} fill={c} fontFamily="var(--font-mono)" fontWeight={600}>
              {st} {isNum(score) ? score.toFixed(0) : ""}
            </text>
            {lines.map((l, i) => (
              <text key={i} x={n.x + 8} y={n.y + 47 + i * 13} fontSize={9.5} fill="#9ba8b8" fontFamily="var(--font-mono)">
                {l}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
