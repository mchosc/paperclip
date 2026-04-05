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

function ModelSelect({
  value,
  onChange,
  placeholder,
  models,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  models: Array<{ id: string; label?: string }>;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      <option value="">{placeholder}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
      ))}
    </select>
  );
}

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

      {/* Model pairs: each model type with its fallback */}
      {!isCreate && models && models.length > 0 && (
        <>
          {/* Heartbeat model + fallback */}
          <Field label="Heartbeat model" hint="Cheap model for idle heartbeats. Fallback kicks in on rate limits.">
            <div className="grid grid-cols-2 gap-2">
              <ModelSelect
                value={eff("adapterConfig", "heartbeatModel", String(config.heartbeatModel ?? ""))}
                onChange={(v) => mark("adapterConfig", "heartbeatModel", v || undefined)}
                placeholder="Same as default"
                models={models}
              />
              <ModelSelect
                value={eff("adapterConfig", "fallbackHeartbeatModel", String(config.fallbackHeartbeatModel ?? ""))}
                onChange={(v) => mark("adapterConfig", "fallbackHeartbeatModel", v || undefined)}
                placeholder="No fallback"
                models={models}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground/60">Primary</span>
              <span className="text-[10px] text-muted-foreground/60">Fallback</span>
            </div>
          </Field>

          {/* Complex task model + fallback */}
          <Field label="Complex task model" hint="Premium model for hard tasks (triage >= 7). Fallback kicks in on rate limits.">
            <div className="grid grid-cols-2 gap-2">
              <ModelSelect
                value={eff("adapterConfig", "complexModel", String(config.complexModel ?? ""))}
                onChange={(v) => mark("adapterConfig", "complexModel", v || undefined)}
                placeholder="Same as default"
                models={models}
              />
              <ModelSelect
                value={eff("adapterConfig", "fallbackComplexModel", String(config.fallbackComplexModel ?? ""))}
                onChange={(v) => mark("adapterConfig", "fallbackComplexModel", v || undefined)}
                placeholder="No fallback"
                models={models}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground/60">Primary</span>
              <span className="text-[10px] text-muted-foreground/60">Fallback</span>
            </div>
          </Field>

          {/* Default model fallback */}
          <Field label="Default model fallback" hint="Backup for the main model when it hits rate limits or quota errors.">
            <ModelSelect
              value={eff("adapterConfig", "fallbackModel", String(config.fallbackModel ?? ""))}
              onChange={(v) => mark("adapterConfig", "fallbackModel", v || undefined)}
              placeholder="No fallback"
              models={models}
            />
          </Field>
        </>
      )}

      {/* Skip synthesis mode — edit mode only */}
      {!isCreate && (
        <Field label="Skip synthesis mode" hint="Agent uses its own instructions even on parent issues with completed subtasks. Enable for utility agents (e.g., email).">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={eff("adapterConfig", "skipSynthesisMode", Boolean(config.skipSynthesisMode ?? false))}
              onChange={(e) => mark("adapterConfig", "skipSynthesisMode", e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-muted-foreground">Enabled</span>
          </label>
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
