"use client";

import { CommandHistory, CommandPanel } from "@/components/command-panel";
import { PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";

export default function CommandsPage() {
  const live = useLive();
  const history = useApi(() => api.commandHistory(100), [live.backend.state === "ONLINE"], { intervalMs: 10_000 });
  return (
    <div className="space-y-3">
      <PageHeader title="Command & control" subtitle="Simulated command workflow: validate → confirm → execute → log" />
      <div className="grid gap-3 xl:grid-cols-[480px_minmax(0,1fr)]">
        <CommandPanel onHistoryChange={history.reload} />
        <CommandHistory items={history.data ?? []} loading={history.loading} error={history.error} />
      </div>
    </div>
  );
}
