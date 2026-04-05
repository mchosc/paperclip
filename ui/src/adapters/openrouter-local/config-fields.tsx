import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function OpenRouterLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {/* Instructions file */}
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values?.instructionsFilePath ?? ""
                  : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
              }
              onCommit={(v) =>
                isCreate
                  ? set?.({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}

      {/* Timeout — edit mode only */}
      {!isCreate && (
        <Field label="Timeout (seconds)" hint="Max execution time per run (default: 600)">
          <DraftInput
            value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "600"))}
            onCommit={(v) => mark("adapterConfig", "timeoutSec", v ? Number(v) : undefined)}
            immediate
            className={inputClass}
            placeholder="600"
          />
        </Field>
      )}

      {/* Max turns — edit mode only */}
      {!isCreate && (
        <Field label="Max turns" hint="Max conversation turns per run (default: 30)">
          <DraftInput
            value={eff("adapterConfig", "maxTurns", String(config.maxTurns ?? "30"))}
            onCommit={(v) => mark("adapterConfig", "maxTurns", v ? Number(v) : undefined)}
            immediate
            className={inputClass}
            placeholder="30"
          />
        </Field>
      )}

      {/* Heartbeat model — edit mode only */}
      {!isCreate && models && models.length > 0 && (
        <Field label="Heartbeat model" hint="Cheapest model for idle heartbeats with no tasks. Saves costs on status checks.">
          <select
            value={eff("adapterConfig", "heartbeatModel", String(config.heartbeatModel ?? ""))}
            onChange={(e) => mark("adapterConfig", "heartbeatModel", e.target.value || undefined)}
            className={inputClass}
          >
            <option value="">Same as default model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
            ))}
          </select>
        </Field>
      )}

      {/* Complex task model — edit mode only */}
      {!isCreate && models && models.length > 0 && (
        <Field label="Complex task model" hint="Premium model for high-complexity tasks (triage score >= 7). Better reasoning for hard problems.">
          <select
            value={eff("adapterConfig", "complexModel", String(config.complexModel ?? ""))}
            onChange={(e) => mark("adapterConfig", "complexModel", e.target.value || undefined)}
            className={inputClass}
          >
            <option value="">Same as default model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
            ))}
          </select>
        </Field>
      )}

      {/* Fallback models — edit mode only */}
      {!isCreate && (
        <Field label="Fallback models" hint="Comma-separated model IDs to try when the primary model hits rate limits or quota errors. Tried in order.">
          <DraftInput
            value={eff("adapterConfig", "fallbackModels", Array.isArray(config.fallbackModels) ? (config.fallbackModels as string[]).join(", ") : String(config.fallbackModels ?? ""))}
            onCommit={(v) => mark("adapterConfig", "fallbackModels", v ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined)}
            immediate
            className={inputClass}
            placeholder="e.g. mistralai/mistral-small-3.2-24b-instruct, deepseek/deepseek-v3.2"
          />
        </Field>
      )}

      {/* Desired skills — edit mode only */}
      {!isCreate && (
        <Field label="Skills" hint="Comma-separated skill names to load (e.g. xlsx,pdf,frontend-design). The 'paperclip' skill is always included.">
          <DraftInput
            value={eff("adapterConfig", "desiredSkills", Array.isArray(config.desiredSkills) ? (config.desiredSkills as string[]).join(", ") : "")}
            onCommit={(v) => mark("adapterConfig", "desiredSkills", v ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined)}
            immediate
            className={inputClass}
            placeholder="paperclip (default — add more as needed)"
          />
        </Field>
      )}
    </>
  );
}
