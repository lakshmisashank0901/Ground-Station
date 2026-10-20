"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { SATELLITE_ID } from "@/lib/config";
import { fmtUtc } from "@/lib/formatters";
import { useApi } from "@/lib/hooks";
import { useLive, useOperator } from "@/lib/live-data";
import type { CommandDef, CommandParamDef, CommandRecord } from "@/lib/types";
import { Button, Dialog, EmptyState, ErrorNote, Field, Panel, StatusBadge } from "./ui";

function coerce(p: CommandParamDef, raw: string): unknown {
  if (raw === "") return undefined;
  const t = p.type.toLowerCase();
  if (t === "int" || t === "integer") return Number.isInteger(Number(raw)) ? Number(raw) : raw;
  if (t === "float" || t === "number") return Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (t === "bool" || t === "boolean") return raw === "true";
  return raw;
}

function ResultView({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="num max-h-56 overflow-auto rounded-[3px] border border-line bg-bg p-2 text-[11px] whitespace-pre-wrap text-ink-2">{text}</pre>;
}

/** Catalog-driven command form with a confirmation step (spec 10). */
export function CommandPanel({ onHistoryChange }: { onHistoryChange?: () => void }) {
  const live = useLive();
  const [operator] = useOperator();
  const catalog = useApi(() => api.commandCatalog(), [live.backend.state === "ONLINE"]);
  const [command, setCommand] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [target, setTarget] = useState(SATELLITE_ID);
  const [pending, setPending] = useState<CommandRecord | null>(null);
  const [result, setResult] = useState<CommandRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowFree, setAllowFree] = useState(false);

  const list: CommandDef[] = useMemo(() => catalog.data ?? [], [catalog.data]);
  const def = list.find((c) => c.command === command);
  useEffect(() => {
    if (!command && list.length) setCommand(list[0].command);
  }, [list, command]);

  function selectCommand(c: string) {
    setCommand(c);
    setParams({});
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    const body: Record<string, unknown> = {};
    for (const p of def?.parameters ?? []) {
      const v = coerce(p, params[p.name] ?? "");
      if (v !== undefined) body[p.name] = v;
    }
    // Free-form params (for testing validation with unknown commands)
    if (!def) for (const [k, v] of Object.entries(params)) if (v !== "") body[k] = v;
    setBusy(true);
    try {
      const rec = await api.sendCommand({ command: command.trim(), target, parameters: body });
      setPending(rec);
    } catch (ex) {
      setError(ex instanceof ApiError && ex.status === 422 ? `Rejected (422): ${ex.message}` : errorMessage(ex));
    } finally {
      setBusy(false);
      onHistoryChange?.();
    }
  }

  async function decide(confirm: boolean) {
    if (!pending) return;
    setBusy(true);
    try {
      const rec = confirm ? await api.confirmCommand(pending.id) : await api.cancelCommand(pending.id);
      setResult(rec);
      setPending(null);
    } catch (ex) {
      setError(errorMessage(ex));
      setPending(null);
    } finally {
      setBusy(false);
      onHistoryChange?.();
    }
  }

  return (
    <Panel title="Command uplink (simulated)">
      <form onSubmit={submit} className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Command">
            {allowFree ? (
              <input className="field num w-64" value={command} onChange={(e) => selectCommand(e.target.value.toUpperCase())} placeholder="e.g. UNKNOWN_CMD" />
            ) : (
              <select className="field num w-64" value={command} onChange={(e) => selectCommand(e.target.value)}>
                {!list.length ? <option value="">{catalog.error ? "Catalog unavailable" : "Loading…"}</option> : null}
                {list.map((c) => (
                  <option key={c.command} value={c.command}>
                    {c.command}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Target">
            <input className="field num w-24" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <label className="flex items-center gap-1.5 pb-1 text-[11px] text-muted">
            <input type="checkbox" checked={allowFree} onChange={(e) => setAllowFree(e.target.checked)} />
            free-text command
          </label>
        </div>
        {def ? <div className="text-[12px] text-ink-2">{def.description}</div> : null}
        {def?.parameters.length ? (
          <div className="flex flex-wrap gap-2">
            {def.parameters.map((p) => (
              <Field key={p.name} label={`${p.name}${p.required ? " *" : ""} · ${p.type}`}>
                {p.enum?.length ? (
                  <select className="field num w-44" value={params[p.name] ?? ""} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}>
                    <option value="">{p.required ? "— select —" : "(default)"}</option>
                    {p.enum.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="field num w-44"
                    type={["int", "integer", "float", "number"].includes(p.type.toLowerCase()) ? "number" : "text"}
                    min={p.min}
                    max={p.max}
                    placeholder={p.min !== undefined || p.max !== undefined ? `${p.min ?? ""}–${p.max ?? ""}` : undefined}
                    value={params[p.name] ?? ""}
                    onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                  />
                )}
              </Field>
            ))}
          </div>
        ) : def ? (
          <div className="text-[11px] text-muted">No parameters.</div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || !command.trim()}>
            Validate &amp; queue
          </Button>
          <span className="text-[11px] text-muted">
            Every command is validated, logged and requires confirmation · operator <span className="num text-ink">{operator}</span>
          </span>
        </div>
        <ErrorNote>{error}</ErrorNote>
      </form>

      {result ? (
        <div className="mt-3 rounded-[3px] border border-line bg-panel-2 p-2">
          <div className="flex items-center justify-between">
            <span className="num text-[12px] text-ink">
              {result.command} → {result.target}
            </span>
            <StatusBadge status={result.status} />
          </div>
          <div className="num mt-0.5 text-[10px] text-muted">
            {result.id} · {fmtUtc(result.timestamp)}
            {result.confirmed_at ? ` · confirmed ${fmtUtc(result.confirmed_at)}` : ""}
          </div>
          <div className="label mt-2 mb-1">Result</div>
          <ResultView value={result.result} />
        </div>
      ) : null}

      <Dialog
        open={!!pending}
        onClose={() => decide(false)}
        title="Confirm command"
        footer={
          <>
            <Button onClick={() => decide(false)} disabled={busy}>
              Cancel command
            </Button>
            <Button variant="danger" onClick={() => decide(true)} disabled={busy}>
              {busy ? "Sending…" : "Confirm & send"}
            </Button>
          </>
        }
      >
        {pending ? (
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="num text-[14px] font-semibold text-white">{pending.command}</span>
              <StatusBadge status={pending.status} />
            </div>
            <div className="num text-muted">
              target {pending.target} · id {pending.id} · by {pending.user}
            </div>
            <div>
              <div className="label mb-1">Parameters</div>
              <ResultView value={Object.keys(pending.parameters ?? {}).length ? pending.parameters : "none"} />
            </div>
            <div className="text-warning">The command passed validation and is awaiting operator confirmation.</div>
          </div>
        ) : null}
      </Dialog>
    </Panel>
  );
}

export function CommandHistory({ items, loading, error }: { items: CommandRecord[]; loading: boolean; error: string | null }) {
  return (
    <Panel title={`Command history · ${items.length}`} bodyClassName="p-0 max-h-[520px] overflow-auto">
      {error && !items.length ? (
        <EmptyState>History unavailable ({error})</EmptyState>
      ) : !items.length ? (
        <EmptyState>{loading ? "Loading…" : "No commands sent yet"}</EmptyState>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>User</th>
              <th>Command</th>
              <th>Target</th>
              <th>Parameters</th>
              <th>Status</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="num whitespace-nowrap">{fmtUtc(c.timestamp)}</td>
                <td className="num">{c.user}</td>
                <td className="num font-semibold text-ink">{c.command}</td>
                <td className="num">{c.target}</td>
                <td className="num max-w-[200px] truncate text-muted" title={JSON.stringify(c.parameters)}>
                  {Object.keys(c.parameters ?? {}).length ? JSON.stringify(c.parameters) : "—"}
                </td>
                <td>
                  <StatusBadge status={c.status} />
                </td>
                <td className="num max-w-[260px] truncate text-muted" title={c.result == null ? "" : JSON.stringify(c.result)}>
                  {c.result == null ? "—" : typeof c.result === "string" ? c.result : JSON.stringify(c.result)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
