---
title: Dashboard
summary: Understanding the Paperclip dashboard
---

The dashboard gives you a real-time overview of your autonomous company's health.

## What You See

The dashboard displays:

- **Agent status** — how many agents are active, idle, running, or in error state
- **Task breakdown** — counts by status (todo, in progress, blocked, done)
- **Stale tasks** — tasks that have been in progress for too long without updates
- **Cost summary** — current month spend vs budget, burn rate
- **Recent activity** — latest mutations across the company
- **LLM Stack** — every model the stack is configured to call, grouped by adapter, plugin, or service (collapsible; collapsed by default)

## Using the Dashboard

Access the dashboard from the left sidebar after selecting a company. It refreshes in real time via live updates.

### Key Metrics to Watch

- **Blocked tasks** — these need your attention. Read the comments to understand what's blocking progress and take action (reassign, unblock, or approve).
- **Budget utilization** — agents auto-pause at 100% budget. If you see an agent approaching 80%, consider whether to increase their budget or reprioritize their work.
- **Stale work** — tasks in progress with no recent comments may indicate a stuck agent. Check the agent's run history for errors.

## Dashboard API

The dashboard data is also available via the API:

```
GET /api/companies/{companyId}/dashboard
```

Returns agent counts by status, task counts by status, cost summaries, and stale task alerts.

```
GET /api/companies/{companyId}/llm-status
```

Returns a unified `consumers[]` array covering every LLM the stack is configured to use, in three groups:

- **Adapters** — agent adapter types currently in use by non-terminated agents in this company. Each adapter lists the specific models its agents have configured (`model`, `heartbeatModel`, `complexModel`, `fallbackModel`, `fallbackHeartbeatModel`, `fallbackComplexModel`), with role pills and per-model 7-day usage aggregates from `heartbeat_runs` (run count, error count, rate-limit detection, last-run timestamp).
- **Plugins** — installed plugins that declare LLM model fields in their `instanceConfigSchema` OR set them in `plugin_config`. Field discovery walks the union of schema property keys and config keys, matching `/[Mm]odel$/`. A small static map covers plugins with hardcoded LLM calls that aren't reachable via config introspection (currently `paperclip-plugin-telegram` and `animusystems.ceo-chat`).
- **Services** — explicit registry of stack services that call LLMs:
  - **MemOS** — chat / MemReader / embedder / reranker models parsed from `/data/config/memos.env` (volume-mounted from `${HOST_PAPERCLIP_DATA}/memos.env`), with `process.env` fallback. Service health from `GET /health`.
  - **Ollama** — every loaded model discovered via `GET /api/tags` against `OLLAMA_URL` (default `http://host.docker.internal:11434`). Models matching `/embed/i` get the `embedding` role; others default to `primary`.

Each consumer's top-level `health` rolls up the worst-case across its model healths. Health values: `healthy`, `idle`, `degraded`, `error`, `rate-limited`, `unknown`. Auth is `assertCompanyAccess` — same as the main dashboard endpoint.
