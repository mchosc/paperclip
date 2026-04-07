import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Cpu, Cloud, Server, Puzzle, Database } from "lucide-react";
import { llmStatusApi, type LlmConsumer, type Health, type RuntimeKind } from "../api/llmStatus";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

const COLLAPSE_STORAGE_KEY = "llmStatusWidget.collapsed";

interface LlmStatusWidgetProps {
  companyId: string;
}

const HEALTH_DOT: Record<Health, string> = {
  healthy: "bg-emerald-500",
  idle: "bg-muted-foreground/40",
  "rate-limited": "bg-amber-400",
  degraded: "bg-orange-500",
  error: "bg-red-500",
  unknown: "bg-muted-foreground/25",
};

const RUNTIME_ICON: Record<RuntimeKind, typeof Cpu> = {
  "in-process": Cpu,
  "remote-api": Cloud,
  "http-sidecar": Server,
  "external-plugin": Puzzle,
  service: Database,
};

const SECTION_ORDER: Array<{ kind: LlmConsumer["kind"]; title: string }> = [
  { kind: "adapter", title: "Agent Adapters" },
  { kind: "plugin", title: "Plugins" },
  { kind: "service", title: "Services" },
];

export function LlmStatusWidget({ companyId }: LlmStatusWidgetProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    // Default to collapsed when no preference has been recorded yet.
    return stored === null ? true : stored === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.llmStatus(companyId),
    queryFn: () => llmStatusApi.get(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const grouped = useMemo(() => {
    const byKind = new Map<LlmConsumer["kind"], LlmConsumer[]>();
    for (const c of data?.consumers ?? []) {
      const list = byKind.get(c.kind) ?? [];
      list.push(c);
      byKind.set(c.kind, list);
    }
    return byKind;
  }, [data]);

  const totalConsumers = data?.consumers.length ?? 0;

  const header = (
    <button
      type="button"
      onClick={() => setCollapsed((c) => !c)}
      className="flex w-full items-center gap-2 text-left text-sm font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      aria-expanded={!collapsed}
    >
      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      <span>LLM Stack</span>
      {totalConsumers > 0 && (
        <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
          {totalConsumers} consumer{totalConsumers === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-3">{header}</div>
        {!collapsed && <div className="h-24 animate-pulse rounded bg-muted-foreground/10" />}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-3">{header}</div>
        {!collapsed && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      </div>
    );
  }

  if (!data || data.consumers.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className={collapsed ? "" : "mb-3"}>{header}</div>
      {!collapsed && (
        <div className="space-y-5">
          {SECTION_ORDER.map(({ kind, title }) => {
            const items = grouped.get(kind) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={kind}>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {title}
                </h4>
                <div className="grid auto-rows-min items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((consumer) => (
                    <ConsumerCard key={consumer.id} consumer={consumer} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConsumerCard({ consumer }: { consumer: LlmConsumer }) {
  const [showAll, setShowAll] = useState(false);
  const Icon = RUNTIME_ICON[consumer.runtime.kind] ?? Cpu;
  const visibleModels = showAll ? consumer.models : consumer.models.slice(0, 6);
  const hiddenCount = consumer.models.length - visibleModels.length;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            title={consumer.health}
            className={cn("inline-flex h-2 w-2 shrink-0 rounded-full", HEALTH_DOT[consumer.health])}
          />
          <span className="truncate text-sm font-semibold" title={consumer.name}>
            {consumer.name}
          </span>
          {consumer.source === "external" && (
            <span className="rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              ext
            </span>
          )}
          {consumer.disabled && (
            <span className="rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              disabled
            </span>
          )}
          {consumer.overridePaused && (
            <span className="rounded bg-amber-100 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              paused
            </span>
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
          title={consumer.runtime.label}
        >
          <Icon className="h-3 w-3" />
          <span className="max-w-[140px] truncate">{consumer.runtime.label}</span>
        </div>
      </div>

      {consumer.models.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">No models configured.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {visibleModels.map((model, idx) => {
            const roles = model.roles ?? [];
            return (
              <li
                key={`${model.id}-${roles.join(",")}-${idx}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]"
              >
                <span
                  className={cn(
                    "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                    HEALTH_DOT[model.health ?? "unknown"],
                  )}
                />
                <span className="truncate font-mono text-[11px]" title={model.id}>
                  {model.id}
                </span>
                {roles.map((role) => (
                  <span
                    key={role}
                    className="rounded bg-muted px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground"
                  >
                    {role}
                  </span>
                ))}
                {model.health === "rate-limited" && (
                  <span className="rounded bg-amber-100 px-1 py-px text-[9px] uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    rate-limited
                  </span>
                )}
                {typeof model.runs7d === "number" && model.runs7d > 0 && (
                  <span className="ml-auto text-muted-foreground/70">{model.runs7d}× 7d</span>
                )}
                {model.lastRunAt && (
                  <span className="text-muted-foreground/60">{relativeTime(model.lastRunAt)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-left text-[10px] text-muted-foreground hover:text-foreground"
        >
          + {hiddenCount} more
        </button>
      )}
    </div>
  );
}
