import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseEnvFile,
  parseMemosEnv,
  deriveAdapterRuntime,
  deriveAdapterModelHealth,
  rollupHealth,
  deriveProviderFromModelId,
  deriveRoleFromKey,
  safeOrigin,
  buildPluginConsumers,
  discoverOllamaModels,
  type Health,
  type PluginRow,
} from "../services/llm-status.js";

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-status-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses key=value lines, ignoring comments and blank lines", () => {
    const file = path.join(tmpDir, "test.env");
    fs.writeFileSync(
      file,
      [
        "# header comment",
        "",
        "KEY_A=value-a",
        "KEY_B = value-b",
        "  # indented comment",
        "KEY_C=value/with/slashes",
        "",
      ].join("\n"),
    );
    const result = parseEnvFile(file);
    expect(result).toEqual({
      KEY_A: "value-a",
      KEY_B: "value-b",
      KEY_C: "value/with/slashes",
    });
  });

  it("strips surrounding quotes (single and double)", () => {
    const file = path.join(tmpDir, "quoted.env");
    fs.writeFileSync(file, ['KEY_DQ="hello world"', "KEY_SQ='hi there'", "KEY_PLAIN=raw"].join("\n"));
    const result = parseEnvFile(file);
    expect(result).toEqual({
      KEY_DQ: "hello world",
      KEY_SQ: "hi there",
      KEY_PLAIN: "raw",
    });
  });

  it("throws when the file does not exist", () => {
    expect(() => parseEnvFile(path.join(tmpDir, "missing.env"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseMemosEnv
// ---------------------------------------------------------------------------

describe("parseMemosEnv", () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-status-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("surfaces chat / memreader / embedder / reranker models from a memos.env file", () => {
    const file = path.join(tmpDir, "memos.env");
    fs.writeFileSync(
      file,
      [
        "MOS_CHAT_MODEL=mistralai/mistral-small-3.2-24b-instruct",
        "MOS_CHAT_MODEL_PROVIDER=openai",
        "OPENAI_API_BASE=https://openrouter.ai/api/v1",
        "MEMRADER_MODEL=mistralai/mistral-small-3.2-24b-instruct",
        "MOS_EMBEDDER_BACKEND=ollama",
        "MOS_EMBEDDER_MODEL=nomic-embed-text:latest",
        "MOS_RERANKER_BACKEND=http_bge",
        "MOS_RERANKER_MODEL=bge-reranker-v2-m3",
      ].join("\n"),
    );

    const { models } = parseMemosEnv(file);

    expect(models).toHaveLength(4);

    const chat = models.find((m) => m.roles?.[0] === "primary");
    expect(chat).toBeDefined();
    expect(chat?.id).toBe("mistralai/mistral-small-3.2-24b-instruct");
    expect(chat?.provider).toBe("openrouter");

    const memreader = models.find((m) => m.roles?.[0] === "extraction");
    expect(memreader).toBeDefined();
    expect(memreader?.provider).toBe("openrouter");

    const embed = models.find((m) => m.roles?.[0] === "embedding");
    expect(embed).toBeDefined();
    expect(embed?.id).toBe("nomic-embed-text:latest");
    expect(embed?.provider).toBe("ollama");

    const reranker = models.find((m) => m.roles?.[0] === "reranker");
    expect(reranker).toBeDefined();
    expect(reranker?.provider).toBe("http_bge");
  });

  it("falls back to process.env when the file path is null", () => {
    process.env.MOS_CHAT_MODEL = "gpt-4o-mini";
    process.env.MOS_CHAT_MODEL_PROVIDER = "openai";
    process.env.OPENAI_API_BASE = "https://api.openai.com/v1";
    process.env.MOS_EMBEDDER_MODEL = "text-embedding-3-small";
    process.env.MOS_EMBEDDER_BACKEND = "openai";
    delete process.env.MEMRADER_MODEL;
    delete process.env.MOS_RERANKER_MODEL;

    const { models } = parseMemosEnv(null);

    expect(models).toHaveLength(2);
    const chat = models.find((m) => m.roles?.[0] === "primary");
    expect(chat?.id).toBe("gpt-4o-mini");
    expect(chat?.provider).toBe("openai");
    const embed = models.find((m) => m.roles?.[0] === "embedding");
    expect(embed?.id).toBe("text-embedding-3-small");
  });

  it("returns empty model list when both file and process.env are empty", () => {
    delete process.env.MOS_CHAT_MODEL;
    delete process.env.MEMRADER_MODEL;
    delete process.env.MOS_EMBEDDER_MODEL;
    delete process.env.MOS_RERANKER_MODEL;
    const { models } = parseMemosEnv(null);
    expect(models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveAdapterRuntime
// ---------------------------------------------------------------------------

describe("deriveAdapterRuntime", () => {
  it("labels external plugin adapters with their package name", () => {
    const result = deriveAdapterRuntime("droid_local", "external", "@acme/droid", []);
    expect(result).toEqual({ kind: "external-plugin", label: "@acme/droid" });
  });

  it("collects unique webhook origins for the http adapter", () => {
    const result = deriveAdapterRuntime("http", "builtin", undefined, [
      { adapterType: "http", adapterConfig: { webhookUrl: "http://a0-adapter:4000/heartbeat" } },
      { adapterType: "http", adapterConfig: { webhookUrl: "http://a0-adapter:4000/other" } },
      { adapterType: "http", adapterConfig: { webhookUrl: "http://other:9000/x" } },
      { adapterType: "claude_local", adapterConfig: {} },
    ]);
    expect(result.kind).toBe("http-sidecar");
    expect(result.label).toBe("http://a0-adapter:4000");
    expect(result.hosts).toEqual(["http://a0-adapter:4000", "http://other:9000"]);
  });

  it("returns 'unconfigured' when no http agent has a webhookUrl", () => {
    const result = deriveAdapterRuntime("http", "builtin", undefined, []);
    expect(result.label).toBe("unconfigured");
    expect(result.hosts).toEqual([]);
  });

  it("maps known builtin adapter types to remote-api or in-process", () => {
    expect(deriveAdapterRuntime("openrouter", "builtin", undefined, []).kind).toBe("remote-api");
    expect(deriveAdapterRuntime("openrouter", "builtin", undefined, []).label).toBe("openrouter.ai");
    expect(deriveAdapterRuntime("claude_local", "builtin", undefined, []).label).toBe(
      "api.anthropic.com (CLI)",
    );
    expect(deriveAdapterRuntime("gemini_local", "builtin", undefined, []).label).toContain(
      "googleapis",
    );
    expect(deriveAdapterRuntime("codex_local", "builtin", undefined, []).kind).toBe("in-process");
    expect(deriveAdapterRuntime("process", "builtin", undefined, []).label).toBe("subprocess");
  });
});

// ---------------------------------------------------------------------------
// deriveAdapterModelHealth
// ---------------------------------------------------------------------------

describe("deriveAdapterModelHealth", () => {
  it("returns 'unknown' for an unconfigured model with no runs", () => {
    expect(
      deriveAdapterModelHealth({
        configured: false,
        runs7d: 0,
        errors7d: 0,
        rateLimited7d: 0,
        lastRunAt: null,
      }),
    ).toBe("unknown");
  });

  it("returns 'idle' for a configured model with no runs", () => {
    expect(
      deriveAdapterModelHealth({
        configured: true,
        runs7d: 0,
        errors7d: 0,
        rateLimited7d: 0,
        lastRunAt: null,
      }),
    ).toBe("idle");
  });

  it("returns 'rate-limited' when a recent run hit the rate limiter", () => {
    expect(
      deriveAdapterModelHealth({
        configured: true,
        runs7d: 5,
        errors7d: 1,
        rateLimited7d: 1,
        lastRunAt: new Date(Date.now() - 60_000),
      }),
    ).toBe("rate-limited");
  });

  it("returns 'error' when half or more runs failed", () => {
    expect(
      deriveAdapterModelHealth({
        configured: true,
        runs7d: 4,
        errors7d: 2,
        rateLimited7d: 0,
        lastRunAt: new Date(),
      }),
    ).toBe("error");
  });

  it("returns 'degraded' when some runs failed but not majority", () => {
    expect(
      deriveAdapterModelHealth({
        configured: true,
        runs7d: 10,
        errors7d: 1,
        rateLimited7d: 0,
        lastRunAt: new Date(),
      }),
    ).toBe("degraded");
  });

  it("returns 'healthy' when there are runs and no errors", () => {
    expect(
      deriveAdapterModelHealth({
        configured: true,
        runs7d: 10,
        errors7d: 0,
        rateLimited7d: 0,
        lastRunAt: new Date(),
      }),
    ).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// rollupHealth
// ---------------------------------------------------------------------------

describe("rollupHealth", () => {
  it("picks the worst health from a list", () => {
    expect(rollupHealth(["healthy", "idle", "error"] as Health[])).toBe("error");
    expect(rollupHealth(["healthy", "degraded"] as Health[])).toBe("degraded");
    expect(rollupHealth(["healthy", "rate-limited"] as Health[])).toBe("rate-limited");
    expect(rollupHealth(["healthy", "healthy"] as Health[])).toBe("healthy");
  });

  it("returns fallback for empty list", () => {
    expect(rollupHealth([], "idle")).toBe("idle");
    expect(rollupHealth([])).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// deriveProviderFromModelId
// ---------------------------------------------------------------------------

describe("deriveProviderFromModelId", () => {
  it("recognizes well-known provider prefixes", () => {
    expect(deriveProviderFromModelId("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(deriveProviderFromModelId("gemini-2.5-flash")).toBe("google");
    expect(deriveProviderFromModelId("gpt-4o-mini")).toBe("openai");
    expect(deriveProviderFromModelId("google/gemini-2.5-flash")).toBe("google");
    expect(deriveProviderFromModelId("anthropic/claude-3.5-sonnet")).toBe("anthropic");
    expect(deriveProviderFromModelId("openai/gpt-4o")).toBe("openai");
    expect(deriveProviderFromModelId("mistralai/mistral-small")).toBe("openrouter");
  });

  it("returns undefined for unknown shapes", () => {
    expect(deriveProviderFromModelId("custom-model")).toBeUndefined();
    expect(deriveProviderFromModelId(undefined)).toBeUndefined();
    expect(deriveProviderFromModelId(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveRoleFromKey
// ---------------------------------------------------------------------------

describe("deriveRoleFromKey", () => {
  it("maps well-known key naming conventions to roles", () => {
    expect(deriveRoleFromKey("llmExtractionModel")).toBe("extraction");
    expect(deriveRoleFromKey("kbBriefModel")).toBe("brief");
    expect(deriveRoleFromKey("llmFallbackModel")).toBe("fallback");
    expect(deriveRoleFromKey("embeddingModel")).toBe("embedding");
    expect(deriveRoleFromKey("rerankerModel")).toBe("reranker");
    expect(deriveRoleFromKey("heartbeatModel")).toBe("heartbeat");
    expect(deriveRoleFromKey("complexModel")).toBe("complex");
    expect(deriveRoleFromKey("model")).toBe("primary");
    expect(deriveRoleFromKey("chatModel")).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// safeOrigin
// ---------------------------------------------------------------------------

describe("safeOrigin", () => {
  it("returns the origin of a valid URL", () => {
    expect(safeOrigin("http://a0-adapter:4000/heartbeat")).toBe("http://a0-adapter:4000");
    expect(safeOrigin("https://api.example.com/v1/path")).toBe("https://api.example.com");
  });

  it("returns null for non-string or invalid input", () => {
    expect(safeOrigin(undefined)).toBeNull();
    expect(safeOrigin(null)).toBeNull();
    expect(safeOrigin("")).toBeNull();
    expect(safeOrigin("not-a-url")).toBeNull();
    expect(safeOrigin(123)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPluginConsumers
// ---------------------------------------------------------------------------

describe("buildPluginConsumers", () => {
  function makePlugin(overrides: Partial<PluginRow> & { id: string; pluginKey: string }): PluginRow {
    return {
      packageName: overrides.pluginKey,
      version: "0.0.1",
      status: "installed",
      manifestJson: {},
      ...overrides,
    };
  }

  it("surfaces a schema-declared model field with default value", () => {
    const plugin = makePlugin({
      id: "p1",
      pluginKey: "test.schema-only",
      manifestJson: {
        displayName: "Test Schema",
        instanceConfigSchema: {
          properties: {
            llmModel: { type: "string", default: "openai/gpt-4o-mini" },
          },
        },
      },
    });
    const result = buildPluginConsumers([plugin], new Map());
    expect(result).toHaveLength(1);
    expect(result[0].models).toHaveLength(1);
    expect(result[0].models[0]).toMatchObject({
      id: "openai/gpt-4o-mini",
      configKey: "llmModel",
      roles: ["primary"],
      configured: true,
    });
  });

  it("surfaces a schema-declared model field with config override", () => {
    const plugin = makePlugin({
      id: "p1",
      pluginKey: "test.with-override",
      manifestJson: {
        instanceConfigSchema: {
          properties: {
            llmFallbackModel: { type: "string", default: "google/gemini-2.5-flash" },
          },
        },
      },
    });
    const cfg = new Map([["p1", { llmFallbackModel: "anthropic/claude-3.5-sonnet" }]]);
    const result = buildPluginConsumers([plugin], cfg);
    expect(result[0].models[0]).toMatchObject({
      id: "anthropic/claude-3.5-sonnet",
      roles: ["fallback"],
      configured: true,
    });
  });

  it("surfaces a config-only model field that is not declared in the schema (Gap 1)", () => {
    // Mirrors the agent-memory plugin's kbBriefModel: in plugin_config but
    // missing from instanceConfigSchema.properties.
    const plugin = makePlugin({
      id: "p1",
      pluginKey: "animusystems.agent-memory",
      manifestJson: {
        displayName: "Agent Memory",
        instanceConfigSchema: {
          properties: {
            llmExtractionModel: { type: "string", default: "mistralai/mistral-small-3.2-24b-instruct" },
            llmFallbackModel: { type: "string", default: "google/gemini-2.5-flash" },
          },
        },
      },
    });
    const cfg = new Map([
      [
        "p1",
        {
          llmExtractionModel: "mistralai/mistral-small-3.2-24b-instruct",
          kbBriefModel: "mistralai/mistral-small-2603",
        },
      ],
    ]);
    const result = buildPluginConsumers([plugin], cfg);
    expect(result).toHaveLength(1);
    const ids = result[0].models.map((m) => m.id);
    expect(ids).toContain("mistralai/mistral-small-3.2-24b-instruct"); // schema-declared
    expect(ids).toContain("google/gemini-2.5-flash"); // schema default
    expect(ids).toContain("mistralai/mistral-small-2603"); // config-only — Gap 1 fix
    const brief = result[0].models.find((m) => m.id === "mistralai/mistral-small-2603");
    expect(brief?.roles).toEqual(["brief"]);
    expect(brief?.configKey).toBe("kbBriefModel");
  });

  it("appends hardcoded models for known plugins (Gaps 2 & 3)", () => {
    const telegram = makePlugin({
      id: "p1",
      pluginKey: "paperclip-plugin-telegram",
      manifestJson: { displayName: "Telegram", instanceConfigSchema: { properties: {} } },
    });
    const ceoChat = makePlugin({
      id: "p2",
      pluginKey: "animusystems.ceo-chat",
      manifestJson: { displayName: "CEO Chat", instanceConfigSchema: { properties: {} } },
    });
    const result = buildPluginConsumers([telegram, ceoChat], new Map());
    const byKey = new Map(result.map((c) => [c.id, c]));
    const tg = byKey.get("plugin:paperclip-plugin-telegram");
    const ceo = byKey.get("plugin:animusystems.ceo-chat");
    expect(tg?.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6", "whisper-1"]);
    expect(ceo?.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
    // Hardcoded entries carry the file:line in configKey for traceability.
    expect(tg?.models[0].configKey).toContain("hardcoded");
  });

  it("skips plugins that have no schema fields, no config, and no hardcoded entries", () => {
    const plugin = makePlugin({
      id: "p1",
      pluginKey: "test.no-llm",
      manifestJson: { instanceConfigSchema: { properties: { foo: { type: "string" } } } },
    });
    const result = buildPluginConsumers([plugin], new Map());
    expect(result).toHaveLength(0);
  });

  it("skips uninstalled plugins", () => {
    const plugin = makePlugin({
      id: "p1",
      pluginKey: "test.uninstalled",
      status: "uninstalled",
      manifestJson: {
        instanceConfigSchema: { properties: { llmModel: { type: "string", default: "x/y" } } },
      },
    });
    const result = buildPluginConsumers([plugin], new Map());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// discoverOllamaModels
// ---------------------------------------------------------------------------

describe("discoverOllamaModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses /api/tags response into model entries with embedding role detection", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "nomic-embed-text:latest" },
            { name: "llama3.1:8b" },
            { name: "mxbai-embed-large:latest" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const models = await discoverOllamaModels("http://localhost:11434");
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: "nomic-embed-text:latest",
      roles: ["embedding"],
      provider: "ollama",
    });
    expect(models[1]).toMatchObject({
      id: "llama3.1:8b",
      roles: ["primary"],
      provider: "ollama",
    });
    expect(models[2].roles).toEqual(["embedding"]);
  });

  it("returns an empty list when /api/tags returns non-2xx", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const models = await discoverOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
  });

  it("returns an empty list on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const models = await discoverOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
  });

  it("strips trailing slashes from the base URL when constructing /api/tags", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as typeof fetch;
    await discoverOllamaModels("http://localhost:11434/");
    expect(capturedUrl).toBe("http://localhost:11434/api/tags");
  });
});
