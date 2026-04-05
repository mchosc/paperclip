import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listOpenrouterSkills, syncOpenrouterSkills } from "./skills.js";

export const openrouterAdapter: ServerAdapterModule = {
  type: "openrouter_local",
  execute,
  testEnvironment,
  listSkills: listOpenrouterSkills,
  syncSkills: syncOpenrouterSkills,
  models: [
    // Premium
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    { id: "qwen/qwen3.5-plus", label: "Qwen 3.5 Plus" },
    { id: "qwen/qwen3.5-plus-02-15", label: "Qwen 3.5 Plus (02-15)" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    // Standard
    { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
    { id: "deepseek/deepseek-v3.2-speciale", label: "DeepSeek V3.2 Speciale" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
    { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
    { id: "minimax/minimax-m2.7", label: "MiniMax M2.7" },
    { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
    // Cheap (good for heartbeats)
    { id: "mistralai/mistral-small-3.2-24b-instruct", label: "Mistral Small 3.2 24B" },
    { id: "meta-llama/llama-4-scout", label: "Llama 4 Scout (cheapest)" },
    { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite ($0.10)" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  ],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# openrouter_local agent configuration

Adapter: openrouter_local

Uses OpenRouter Chat Completions API with any supported model.
Requires OPENROUTER_API_KEY or OPENAI_API_KEY environment variable.

Core fields:
- model (string, required): OpenRouter model ID (e.g. "deepseek/deepseek-v3.2-speciale")
- instructionsFilePath (string, optional): absolute path to agent instructions markdown file (e.g. AGENTS.md)
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): bootstrap prompt prepended to each run
- cwd (string, optional): working directory
- env (object, optional): environment variables

Operational fields:
- timeoutSec (number, optional): timeout in seconds (default: 600)
- maxTurns (number, optional): max conversation turns (default: 30)
- heartbeatModel (string, optional): cheap model for idle heartbeats (default: same as model)
- complexModel (string, optional): premium model for high-complexity tasks (triage score >= 7)
- desiredSkills (string[], optional): skills to load into prompt (e.g. ["xlsx", "pdf"]). The "paperclip" skill is always included.
`,
};
