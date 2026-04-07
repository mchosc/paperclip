/**
 * LLM Status service — discovers every LLM consumer in the Paperclip stack
 * (agent adapters, plugins, and known external services) and returns a single
 * unified view enriched with usage and health.
 *
 * This powers the LlmStatusWidget on the company dashboard.
 *
 * Three discovery passes:
 *   1. Adapters — listServerAdapters() + per-agent adapterConfig + 7d run
 *      aggregates from heartbeat_runs.
 *   2. Plugins — pluginRegistryService.list() + manifest.instanceConfigSchema
 *      introspection (any property whose key matches /[Mm]odel$/ is treated
 *      as a model field).
 *   3. Services — explicit registry (MemOS today). Each service has an HTTP
 *      /health check and an optional config-file parser that surfaces its
 *      configured models. MemOS reads /data/config/memos.env (volume-mounted
 *      from the host) with process.env fallback for host-mode dev.
 */

import fs from "node:fs";
import { and, eq, gte, ne, sql, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, plugins, pluginConfig } from "@paperclipai/db";
import {
  listServerAdapters,
  waitForExternalAdapters,
} from "../adapters/registry.js";
import {
  listAdapterPlugins,
  getDisabledAdapterTypes,
} from "./adapter-plugin-store.js";
import { isOverridePaused } from "../adapters/registry.js";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConsumerKind = "adapter" | "plugin" | "service";

export type RuntimeKind =
  | "in-process"
  | "http-sidecar"
  | "remote-api"
  | "external-plugin"
  | "service";

export type Health =
  | "healthy"
  | "idle"
  | "degraded"
  | "error"
  | "rate-limited"
  | "unknown";

export type HealthSource = "heartbeat_runs" | "http-ping" | "config-only";

export type ModelRole =
  | "primary"
  | "heartbeat"
  | "complex"
  | "fallback"
  | "fallback-heartbeat"
  | "fallback-complex"
  | "extraction"
  | "brief"
  | "embedding"
  | "reranker";

export interface LlmModel {
  id: string;
  label?: string;
  /** All roles this model fills for this consumer (e.g., primary + fallback). */
  roles?: ModelRole[];
  provider?: string;
  configKey?: string;
  configured?: boolean;
  configuredByAgentIds?: string[];
  runs7d?: number;
  successes7d?: number;
  errors7d?: number;
  rateLimited7d?: number;
  lastRunAt?: string | null;
  lastError?: string | null;
  health?: Health;
}

export interface RuntimeInfo {
  kind: RuntimeKind;
  label: string;
  hosts?: string[];
}

export interface LlmConsumer {
  id: string;
  kind: ConsumerKind;
  name: string;
  description?: string;
  runtime: RuntimeInfo;
  health: Health;
  healthSource: HealthSource;
  // adapter-only
  source?: "builtin" | "external";
  disabled?: boolean;
  overridePaused?: boolean;
  packageName?: string;
  version?: string;
  models: LlmModel[];
}

export interface LlmStatusResponse {
  generatedAt: string;
  consumers: LlmConsumer[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const MODEL_KEY_PATTERN = /[Mm]odel$/;

/** Parse a KEY=VALUE env file. Strips comments, blanks, and surrounding quotes. */
export function parseEnvFile(absPath: string): Record<string, string> {
  const raw = fs.readFileSync(absPath, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding double or single quotes if balanced
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Normalize a webhook URL to its origin (e.g. http://a0-adapter:4000). */
export function safeOrigin(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function uniq<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

/** Map an adapter to a runtime label, based on type + plugin source + agent webhookUrls. */
export function deriveAdapterRuntime(
  adapterType: string,
  source: "builtin" | "external",
  packageName: string | undefined,
  agentRows: Array<{ adapterType: string; adapterConfig: Record<string, unknown> }>,
): RuntimeInfo {
  if (source === "external") {
    return { kind: "external-plugin", label: packageName ?? adapterType };
  }
  if (adapterType === "http") {
    const hosts = uniq(
      agentRows
        .filter((a) => a.adapterType === "http")
        .map((a) => safeOrigin(a.adapterConfig?.webhookUrl))
        .filter((host): host is string => Boolean(host)),
    );
    return { kind: "http-sidecar", label: hosts[0] ?? "unconfigured", hosts };
  }
  switch (adapterType) {
    case "openrouter":
      return { kind: "remote-api", label: "openrouter.ai" };
    case "openclaw_gateway":
      return { kind: "remote-api", label: "openclaw gateway" };
    case "gemini_local":
      return { kind: "remote-api", label: "generativelanguage.googleapis.com" };
    case "claude_local":
      return { kind: "remote-api", label: "api.anthropic.com (CLI)" };
    case "process":
      return { kind: "in-process", label: "subprocess" };
    default:
      return { kind: "in-process", label: "in-process" };
  }
}

const RATE_LIMIT_RX = /429|rate.?limit|quota|capacity/i;

/** Health for one adapter model based on 7d run aggregates. */
export function deriveAdapterModelHealth(args: {
  configured: boolean;
  runs7d: number;
  errors7d: number;
  rateLimited7d: number;
  lastRunAt: Date | null;
}): Health {
  const { configured, runs7d, errors7d, rateLimited7d, lastRunAt } = args;
  if (runs7d === 0 && !configured) return "unknown";
  if (runs7d === 0 && configured) return "idle";
  if (rateLimited7d > 0 && lastRunAt && Date.now() - lastRunAt.getTime() < 60 * 60 * 1000) {
    return "rate-limited";
  }
  if (runs7d > 0 && errors7d / runs7d >= 0.5) return "error";
  if (errors7d > 0) return "degraded";
  return "healthy";
}

/** Worst-case health rollup for a consumer (over its model healths). */
export function rollupHealth(modelHealths: Health[], fallback: Health = "unknown"): Health {
  if (modelHealths.length === 0) return fallback;
  const order: Health[] = ["error", "rate-limited", "degraded", "idle", "healthy", "unknown"];
  for (const h of order) if (modelHealths.includes(h)) return h;
  return fallback;
}

/** Best-effort provider derivation from a model id string. */
export function deriveProviderFromModelId(modelId: string | undefined | null): string | undefined {
  if (!modelId) return undefined;
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1-") || modelId.startsWith("o3-")) {
    return "openai";
  }
  if (modelId.startsWith("google/")) return "google";
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("openai/")) return "openai";
  if (modelId.includes("/")) return "openrouter";
  return undefined;
}

/** Derive a model role from a config key name. Order matters — fallback variants are checked first. */
export function deriveRoleFromKey(key: string): ModelRole {
  const lower = key.toLowerCase();
  if (lower.includes("extract")) return "extraction";
  if (lower.includes("brief")) return "brief";
  if (lower.includes("embed")) return "embedding";
  if (lower.includes("rerank")) return "reranker";
  if (lower.includes("fallback") && lower.includes("heartbeat")) return "fallback-heartbeat";
  if (lower.includes("fallback") && lower.includes("complex")) return "fallback-complex";
  if (lower.includes("fallback")) return "fallback";
  if (lower.includes("heartbeat")) return "heartbeat";
  if (lower.includes("complex")) return "complex";
  return "primary";
}

// ---------------------------------------------------------------------------
// MemOS env file parsing
// ---------------------------------------------------------------------------

interface MemosEnv {
  models: LlmModel[];
}

function deriveProviderFromBaseUrl(
  explicitProvider: string | undefined,
  baseUrl: string | undefined,
): string | undefined {
  if (explicitProvider && explicitProvider !== "openai") return explicitProvider;
  if (baseUrl?.includes("openrouter.ai")) return "openrouter";
  if (baseUrl?.includes("api.openai.com")) return "openai";
  if (baseUrl?.includes("anthropic.com")) return "anthropic";
  return explicitProvider;
}

/**
 * Parse MemOS configuration from a memos.env file (or process.env fallback).
 * Surfaces chat / MemReader / embedder / reranker models with role + provider.
 */
export function parseMemosEnv(filePath: string | null): MemosEnv {
  let env: Record<string, string> = {};
  if (filePath) {
    try {
      env = parseEnvFile(filePath);
    } catch {
      env = {};
    }
  }
  const get = (k: string): string | undefined => env[k] ?? process.env[k];

  const models: LlmModel[] = [];

  const chat = get("MOS_CHAT_MODEL");
  if (chat) {
    models.push({
      id: chat,
      roles: ["primary"],
      provider: deriveProviderFromBaseUrl(get("MOS_CHAT_MODEL_PROVIDER"), get("OPENAI_API_BASE")),
      configKey: "MOS_CHAT_MODEL",
      configured: true,
      health: "healthy",
    });
  }

  const memreader = get("MEMRADER_MODEL");
  if (memreader) {
    models.push({
      id: memreader,
      roles: ["extraction"],
      provider: deriveProviderFromBaseUrl(undefined, get("MEMRADER_API_BASE") ?? get("OPENAI_API_BASE")),
      configKey: "MEMRADER_MODEL",
      configured: true,
      health: "healthy",
    });
  }

  const embedder = get("MOS_EMBEDDER_MODEL");
  if (embedder) {
    models.push({
      id: embedder,
      roles: ["embedding"],
      provider: get("MOS_EMBEDDER_BACKEND"),
      configKey: "MOS_EMBEDDER_MODEL",
      configured: true,
      health: "healthy",
    });
  }

  const reranker = get("MOS_RERANKER_MODEL");
  if (reranker) {
    models.push({
      id: reranker,
      roles: ["reranker"],
      provider: get("MOS_RERANKER_BACKEND"),
      configKey: "MOS_RERANKER_MODEL",
      configured: true,
      health: "healthy",
    });
  }

  return { models };
}

// ---------------------------------------------------------------------------
// Service registry (Pass 3)
// ---------------------------------------------------------------------------

interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  urlEnv: string;
  defaultUrl: string;
  healthPath: string;
  configFileEnv?: string;
  defaultConfigFile?: string;
  parseConfig?: (filePath: string | null) => { models: LlmModel[] };
  /**
   * Optional model discovery via HTTP. Called with the resolved service URL
   * (no path appended). Used by services like Ollama that expose a model list
   * over HTTP rather than via a config file.
   */
  discoverModels?: (baseUrl: string) => Promise<LlmModel[]>;
}

/**
 * Discover loaded Ollama models via /api/tags. Returns an empty list on
 * any error so the tile still renders with health-only.
 *
 * /api/tags response shape: { models: [{ name: "nomic-embed-text:latest", ... }] }
 */
export async function discoverOllamaModels(baseUrl: string): Promise<LlmModel[]> {
  try {
    const url = baseUrl.replace(/\/$/, "") + "/api/tags";
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const list = Array.isArray(body.models) ? body.models : [];
    return list
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map((name) => ({
        id: name,
        // Embedding-shaped models get the embedding role; everything else is primary.
        roles: /embed/i.test(name) ? (["embedding"] as const) : (["primary"] as const),
        provider: "ollama",
        configured: true,
        health: "healthy" as const,
      }));
  } catch {
    return [];
  }
}

const SERVICE_REGISTRY: ServiceDefinition[] = [
  {
    id: "memos",
    name: "MemOS",
    description: "Memory + KB store: chat LLM, MemReader, embeddings, optional reranker.",
    urlEnv: "MEMOS_URL",
    defaultUrl: "http://memos:8000",
    healthPath: "/health",
    configFileEnv: "PAPERCLIP_MEMOS_ENV_FILE",
    defaultConfigFile: "/data/config/memos.env",
    parseConfig: parseMemosEnv,
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local model runtime — backs MemOS embeddings.",
    urlEnv: "OLLAMA_URL",
    defaultUrl: "http://host.docker.internal:11434",
    healthPath: "/api/tags",
    discoverModels: discoverOllamaModels,
  },
];

async function pingHealth(url: string, timeoutMs = 2000): Promise<Health> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return "healthy";
    return "degraded";
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

const MODEL_FIELD_KEYS = [
  "model",
  "heartbeatModel",
  "complexModel",
  "fallbackModel",
  "fallbackHeartbeatModel",
  "fallbackComplexModel",
] as const;

const MODEL_FIELD_TO_ROLE: Record<(typeof MODEL_FIELD_KEYS)[number], ModelRole> = {
  model: "primary",
  heartbeatModel: "heartbeat",
  complexModel: "complex",
  fallbackModel: "fallback",
  fallbackHeartbeatModel: "fallback-heartbeat",
  fallbackComplexModel: "fallback-complex",
};

const ROLE_ORDER: ModelRole[] = [
  "primary",
  "heartbeat",
  "complex",
  "fallback",
  "fallback-heartbeat",
  "fallback-complex",
  "extraction",
  "brief",
  "embedding",
  "reranker",
];

interface AgentRow {
  id: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

interface RunAggregate {
  adapterType: string;
  model: string;
  runs7d: number;
  errors7d: number;
  rateLimited7d: number;
  lastRunAt: Date | null;
  lastError: string | null;
}

export function llmStatusService(db: Db) {
  return {
    getLlmStatus: async (companyId: string): Promise<LlmStatusResponse> => {
      await waitForExternalAdapters();

      // -----------------------------------------------------------------
      // Load company-scoped data (agents + 7d run aggregates) in parallel
      // with the global plugin list.
      // -----------------------------------------------------------------
      const [agentRowsRaw, pluginRows, runAggregates] = await Promise.all([
        db
          .select({
            id: agents.id,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
          })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
        db.select().from(plugins),
        loadRunAggregates(db, companyId),
      ]);

      const agentRows: AgentRow[] = agentRowsRaw.map((r) => ({
        id: r.id,
        adapterType: r.adapterType,
        adapterConfig: (r.adapterConfig ?? {}) as Record<string, unknown>,
      }));

      // -----------------------------------------------------------------
      // Pass 1 — Adapters
      // -----------------------------------------------------------------
      const adapterConsumers = await buildAdapterConsumers(agentRows, runAggregates);

      // -----------------------------------------------------------------
      // Pass 2 — Plugins
      // -----------------------------------------------------------------
      const pluginConfigsById = new Map<string, Record<string, unknown>>();
      if (pluginRows.length > 0) {
        const ids = pluginRows.map((p) => p.id);
        const cfgs = await db
          .select()
          .from(pluginConfig)
          .where(inArray(pluginConfig.pluginId, ids));
        for (const c of cfgs) {
          pluginConfigsById.set(c.pluginId, (c.configJson ?? {}) as Record<string, unknown>);
        }
      }
      const pluginConsumers = buildPluginConsumers(pluginRows, pluginConfigsById);

      // -----------------------------------------------------------------
      // Pass 3 — Services
      // -----------------------------------------------------------------
      const serviceConsumers = await buildServiceConsumers();

      return {
        generatedAt: new Date().toISOString(),
        consumers: [...adapterConsumers, ...pluginConsumers, ...serviceConsumers],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — Adapters
// ---------------------------------------------------------------------------

async function loadRunAggregates(db: Db, companyId: string): Promise<RunAggregate[]> {
  // Aggregate heartbeat_runs over the last 7 days for this company.
  // Joins agents to surface the adapterType, and extracts model from usageJson.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      adapterType: agents.adapterType,
      model: sql<string | null>`${heartbeatRuns.usageJson}->>'model'`,
      runs: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
      rateLimited: sql<number>`count(*) filter (where ${heartbeatRuns.error} ~* '429|rate.?limit|quota|capacity')::int`,
      lastRunAt: sql<Date | null>`max(${heartbeatRuns.finishedAt})`,
      lastError: sql<string | null>`max(${heartbeatRuns.error}) filter (where ${heartbeatRuns.error} is not null)`,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.finishedAt, cutoff),
      ),
    )
    .groupBy(agents.adapterType, sql`${heartbeatRuns.usageJson}->>'model'`);

  return rows
    .filter((r): r is typeof r & { model: string } => Boolean(r.model))
    .map((r) => ({
      adapterType: r.adapterType,
      model: r.model,
      runs7d: Number(r.runs ?? 0),
      errors7d: Number(r.errors ?? 0),
      rateLimited7d: Number(r.rateLimited ?? 0),
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      lastError: r.lastError ?? null,
    }));
}

async function buildAdapterConsumers(
  agentRows: AgentRow[],
  runAggregates: RunAggregate[],
): Promise<LlmConsumer[]> {
  const allAdapters = listServerAdapters();
  const adapterByType = new Map(allAdapters.map((a) => [a.type, a]));
  const externalRecords = new Map(listAdapterPlugins().map((r) => [r.type, r]));
  const disabledSet = new Set(getDisabledAdapterTypes());

  // Group agent rows by adapter type, and pre-compute per-(adapterType, modelId)
  // both the agent ids that reference it AND the set of roles (config keys)
  // it fills.
  const agentsByAdapter = new Map<string, AgentRow[]>();
  interface ModelUsage {
    agentIds: Set<string>;
    roles: Set<ModelRole>;
  }
  const configuredByAdapterModel = new Map<string, Map<string, ModelUsage>>();
  for (const a of agentRows) {
    let bucket = agentsByAdapter.get(a.adapterType);
    if (!bucket) {
      bucket = [];
      agentsByAdapter.set(a.adapterType, bucket);
    }
    bucket.push(a);

    let modelMap = configuredByAdapterModel.get(a.adapterType);
    if (!modelMap) {
      modelMap = new Map();
      configuredByAdapterModel.set(a.adapterType, modelMap);
    }
    for (const key of MODEL_FIELD_KEYS) {
      const val = a.adapterConfig?.[key];
      if (typeof val === "string" && val.length > 0) {
        let usage = modelMap.get(val);
        if (!usage) {
          usage = { agentIds: new Set(), roles: new Set() };
          modelMap.set(val, usage);
        }
        usage.agentIds.add(a.id);
        usage.roles.add(MODEL_FIELD_TO_ROLE[key]);
      }
    }
  }

  // Group run aggregates by adapter type.
  const runsByAdapter = new Map<string, Map<string, RunAggregate>>();
  for (const r of runAggregates) {
    let inner = runsByAdapter.get(r.adapterType);
    if (!inner) {
      inner = new Map();
      runsByAdapter.set(r.adapterType, inner);
    }
    inner.set(r.model, r);
  }

  // Only include adapter types that this company *currently* has agents on.
  // Historical runs alone are not enough — if an agent was reconfigured or
  // deleted, the old adapter should disappear from the widget.
  const usedAdapterTypes = new Set<string>(agentsByAdapter.keys());

  const consumers: LlmConsumer[] = [];

  for (const type of usedAdapterTypes) {
    const adapter = adapterByType.get(type);
    // Adapter type may have been removed or not yet loaded — skip silently.
    if (!adapter) continue;

    const externalRecord = externalRecords.get(type);
    const source: "builtin" | "external" = externalRecord ? "external" : "builtin";
    const disabled = disabledSet.has(type);
    const overridePaused = BUILTIN_ADAPTER_TYPES.has(type)
      ? isOverridePaused(type)
      : undefined;

    const adapterAgents = agentsByAdapter.get(type) ?? [];
    const runtime = deriveAdapterRuntime(type, source, externalRecord?.packageName, adapterAgents);

    const runMap = runsByAdapter.get(type) ?? new Map<string, RunAggregate>();
    const configuredMap =
      configuredByAdapterModel.get(type) ?? new Map<string, ModelUsage>();

    // Only show models that an agent currently has configured. Historical run
    // data is joined in below for enrichment but doesn't introduce new entries.
    const modelEntries = Array.from(configuredMap.entries());

    const models: LlmModel[] = modelEntries.map(([id, usage]) => {
      const agg = runMap.get(id);
      const configuredAgentIds = Array.from(usage.agentIds);
      const configured = configuredAgentIds.length > 0;
      const roles = ROLE_ORDER.filter((r) => usage.roles.has(r));
      const runs7d = agg?.runs7d ?? 0;
      const errors7d = agg?.errors7d ?? 0;
      const rateLimited7d = agg?.rateLimited7d ?? 0;
      const lastRunAt = agg?.lastRunAt ?? null;
      const health = deriveAdapterModelHealth({
        configured,
        runs7d,
        errors7d,
        rateLimited7d,
        lastRunAt,
      });
      return {
        id,
        label: id,
        roles,
        configured,
        configuredByAgentIds: configuredAgentIds,
        provider: deriveProviderFromModelId(id),
        runs7d,
        successes7d: Math.max(0, runs7d - errors7d),
        errors7d,
        rateLimited7d,
        lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
        lastError: agg?.lastError ?? null,
        health,
      };
    });

    const rolledUpHealth = rollupHealth(
      models.map((m) => m.health ?? "unknown"),
      disabled ? "unknown" : "idle",
    );

    consumers.push({
      id: `adapter:${adapter.type}`,
      kind: "adapter",
      name: adapter.type,
      runtime,
      health: rolledUpHealth,
      healthSource: "heartbeat_runs",
      source,
      disabled,
      overridePaused,
      packageName: externalRecord?.packageName,
      version: externalRecord?.version,
      models,
    });
  }

  return consumers.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Pass 2 — Plugins
// ---------------------------------------------------------------------------

export interface PluginRow {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  manifestJson: unknown;
}

/**
 * Known LLM calls that are hardcoded in plugin source code (string literals
 * inside worker.ts), unreachable via instanceConfigSchema introspection.
 *
 * Each entry is a documented coverage gap. Long-term these should migrate to
 * manifest-declared config fields in the plugin source; once they do, the
 * schema/config walk below will pick them up naturally and these entries can
 * be removed.
 *
 * Keyed by `plugins.pluginKey`.
 */
const PLUGIN_HARDCODED_MODELS: Record<string, LlmModel[]> = {
  "paperclip-plugin-telegram": [
    {
      id: "claude-sonnet-4-6",
      roles: ["primary"],
      provider: "anthropic",
      configKey: "(hardcoded: worker.ts:1050)",
      configured: true,
      health: "healthy",
    },
    {
      id: "whisper-1",
      roles: ["extraction"],
      provider: "openai",
      configKey: "(hardcoded: media-pipeline.ts:199)",
      configured: true,
      health: "healthy",
    },
  ],
  "animusystems.ceo-chat": [
    {
      id: "claude-sonnet-4-6",
      roles: ["primary"],
      provider: "anthropic",
      configKey: "(hardcoded: worker.ts:108)",
      configured: true,
      health: "healthy",
    },
  ],
};

export function buildPluginConsumers(
  pluginRows: PluginRow[],
  pluginConfigsById: Map<string, Record<string, unknown>>,
): LlmConsumer[] {
  const out: LlmConsumer[] = [];

  for (const plugin of pluginRows) {
    if (plugin.status === "uninstalled") continue;

    const manifest = ((plugin.manifestJson ?? {}) as Record<string, unknown>);
    const schema = manifest.instanceConfigSchema as Record<string, unknown> | undefined;
    const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;

    const config = pluginConfigsById.get(plugin.id) ?? {};

    // Walk the union of schema property keys and config keys. The schema gives
    // us declared defaults; the config catches model fields the plugin reads
    // at runtime without bothering to declare them in the manifest (e.g.
    // agent-memory's kbBriefModel).
    const candidateKeys = new Set<string>([
      ...Object.keys(properties),
      ...Object.keys(config),
    ]);

    const models: LlmModel[] = [];
    for (const key of candidateKeys) {
      if (!MODEL_KEY_PATTERN.test(key)) continue;
      const prop = properties[key];
      // Schema-declared fields must be string-typed; config-only keys (no
      // schema entry) pass through and are validated below by the value type.
      if (prop && prop.type !== "string") continue;
      const rawValue = config[key] ?? prop?.default;
      const value = typeof rawValue === "string" ? rawValue : undefined;
      if (!value || value.length === 0) {
        // Schema-declared but no value: surface as a placeholder so the
        // operator sees the field exists. Skip purely config-only keys with
        // no value (they have no provenance worth surfacing).
        if (prop) {
          models.push({
            id: "(unset)",
            configKey: key,
            roles: [deriveRoleFromKey(key)],
            configured: false,
            health: "idle",
          });
        }
        continue;
      }
      models.push({
        id: value,
        configKey: key,
        roles: [deriveRoleFromKey(key)],
        provider: deriveProviderFromModelId(value),
        configured: true,
        health: "healthy",
      });
    }

    // Append any documented hardcoded models for this plugin.
    const hardcoded = PLUGIN_HARDCODED_MODELS[plugin.pluginKey] ?? [];
    models.push(...hardcoded);

    if (models.length === 0) continue; // plugin doesn't use LLMs — skip

    const displayName = (manifest.displayName as string | undefined) ?? plugin.pluginKey;
    const description = manifest.description as string | undefined;
    const disabled = plugin.status !== "installed" && plugin.status !== "active";

    const consumerHealth: Health = disabled
      ? "unknown"
      : rollupHealth(models.map((m) => m.health ?? "unknown"), "idle");

    out.push({
      id: `plugin:${plugin.pluginKey}`,
      kind: "plugin",
      name: displayName,
      description,
      runtime: { kind: "external-plugin", label: plugin.packageName },
      health: consumerHealth,
      healthSource: "config-only",
      packageName: plugin.packageName,
      version: plugin.version,
      models,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Pass 3 — Services
// ---------------------------------------------------------------------------

async function buildServiceConsumers(): Promise<LlmConsumer[]> {
  const out: LlmConsumer[] = [];

  for (const svc of SERVICE_REGISTRY) {
    const url = process.env[svc.urlEnv] ?? svc.defaultUrl;
    const healthUrl = url.replace(/\/$/, "") + svc.healthPath;
    const health = await pingHealth(healthUrl);

    let models: LlmModel[] = [];
    if (svc.parseConfig) {
      const filePath = svc.configFileEnv
        ? process.env[svc.configFileEnv] ?? svc.defaultConfigFile ?? null
        : null;
      const exists = filePath ? fileExistsSync(filePath) : false;
      const parsed = svc.parseConfig(exists ? filePath : null);
      models = parsed.models;
    }
    if (svc.discoverModels) {
      models = models.concat(await svc.discoverModels(url));
    }

    out.push({
      id: `service:${svc.id}`,
      kind: "service",
      name: svc.name,
      description: svc.description,
      runtime: { kind: "service", label: url },
      health,
      healthSource: "http-ping",
      models,
    });
  }

  return out;
}

function fileExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
