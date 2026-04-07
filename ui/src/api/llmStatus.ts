/**
 * @fileoverview Frontend client for the unified LLM stack status endpoint
 * powering the LlmStatusWidget on the dashboard.
 */

import { api } from "./client";

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

export const llmStatusApi = {
  get: (companyId: string) =>
    api.get<LlmStatusResponse>(`/companies/${companyId}/llm-status`),
};
