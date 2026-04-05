import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  renderTemplate,
  joinPromptSections,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";
import { readFile, writeFile as writeFileAsync, mkdir, readdir, lstat, symlink, readlink, unlink } from "node:fs/promises";

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname, relative } from "node:path";

const execAsync = promisify(exec);

const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v3.2";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ── Plugin tool integration ─────────────────────────────────
interface PluginToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  pluginId: string;
}

/** Discover plugin-contributed tools from the Paperclip plugin API. */
async function discoverPluginTools(port: string, authHeader?: string): Promise<PluginToolDescriptor[]> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;
    const res = await fetch(`http://localhost:${port}/api/plugins/tools`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    return (await res.json()) as PluginToolDescriptor[];
  } catch {
    return [];
  }
}

/** Convert a plugin tool descriptor to an OpenAI-compatible tool definition. */
function pluginToolToDefinition(tool: PluginToolDescriptor): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name.replace(/[.:]/g, "_"), // normalize for LLM (e.g. "acme.memory:recall" → "acme_memory_recall")
      description: `[Plugin: ${tool.displayName}] ${tool.description}`,
      parameters: tool.parametersSchema,
    },
  };
}

/** Execute a plugin tool via the Paperclip plugin API. */
async function executePluginTool(
  namespacedName: string,
  params: Record<string, unknown>,
  port: string,
  authHeader: string | undefined,
  runContext: { agentId: string; runId: string; companyId: string; projectId: string },
): Promise<string> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;
    const res = await fetch(`http://localhost:${port}/api/plugins/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: namespacedName, parameters: params, runContext }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `Plugin tool error (${res.status}): ${text.substring(0, 500)}`;
    }
    const result = await res.json() as { result?: { content?: string; error?: string } };
    return result?.result?.content || result?.result?.error || "Plugin tool returned no content";
  } catch (err: unknown) {
    return `Plugin tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function sanitize(text: string): string {
  return text.replace(/\x00/g, "");
}

const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command in the agent workspace. Use for file ops, git, builds, etc.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents from the workspace. Supports offset/limit for reading portions of large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace)" },
          offset: { type: "number", description: "Line number to start reading from (1-based, default: 1)" },
          limit: { type: "number", description: "Max number of lines to read (default: all)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make a surgical edit to a file by replacing a specific text block. More efficient than write_file for small changes to large files. The old_text must match exactly (including whitespace/indentation).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace)" },
          old_text: { type: "string", description: "Exact text to find and replace (must be unique in the file)" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories in a path. Returns names with type indicators (/ for dirs). Use for exploring project structure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (relative to workspace, default: '.')" },
          recursive: { type: "boolean", description: "List recursively (default: false, max depth 4)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web via DuckDuckGo.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL (web page or API).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          method: { type: "string", description: "HTTP method (default: GET)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_issue",
      description: "Create a Paperclip issue and optionally assign it to another agent. Use this to delegate work (e.g., email to Hermes).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          description: { type: "string", description: "Issue description with full details" },
          assignee_agent_name: { type: "string", description: "Agent name to assign to (e.g., 'Hermes' for email)" },
        },
        required: ["title", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_issue",
      description: "Update a Paperclip issue's status, title, or description. Use this to mark issues as done, in_progress, blocked, etc. You MUST call this when completing or updating a task.",
      parameters: {
        type: "object",
        properties: {
          issue_identifier: { type: "string", description: "Issue identifier (e.g., 'ANI-157')" },
          status: { type: "string", description: "New status: todo, in_progress, done, blocked, cancelled" },
          title: { type: "string", description: "Updated title (optional)" },
          description: { type: "string", description: "Updated description (optional)" },
        },
        required: ["issue_identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_comment",
      description: "Add a comment to a Paperclip issue. Use this for progress updates, completion summaries, blocker reports, etc.",
      parameters: {
        type: "object",
        properties: {
          issue_identifier: { type: "string", description: "Issue identifier (e.g., 'ANI-157')" },
          body: { type: "string", description: "Comment body (supports markdown)" },
        },
        required: ["issue_identifier", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save an important learning, decision, or fact for future runs. Use when you discover something that should persist across runs — decisions made, facts found, approaches that worked/failed.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The memory to save (a clear, self-contained statement)" },
          category: { type: "string", description: "Memory type: decision, learning, fact, preference, or note", enum: ["decision", "learning", "fact", "preference", "note"] },
          tags: { type: "string", description: "Comma-separated tags for categorization (optional)" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memories",
      description: "Search for relevant context from previous runs. Use when the task depends on prior decisions, people, projects, or long-running context not in the current issue thread.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for — describe the context you need" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an HTML email with optional file attachments. Use for all outbound emails — reports, client communications, notifications. Always use HTML formatting for professional appearance.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address(es), comma-separated" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body in HTML format. Use proper HTML tags: <h1>, <p>, <ul>, <li>, <table>, <strong>, etc." },
          cc: { type: "string", description: "CC recipients, comma-separated (optional)" },
          bcc: { type: "string", description: "BCC recipients, comma-separated (optional)" },
          attachments: { type: "string", description: "Comma-separated workspace file paths to attach (optional)" },
          reply_to: { type: "string", description: "Reply-to address (optional, defaults to sender)" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
];

async function executeToolCall(
  name: string,
  argsStr: string,
  cwd: string,
  onLog: AdapterExecutionContext["onLog"],
  apiContext?: { port: string; authHeader?: string; companyId: string; agentId?: string; runId?: string; agentName?: string; projectId?: string; shellEnv?: Record<string, string> },
): Promise<string> {
  let args: Record<string, string>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    return `Error: Invalid JSON: ${argsStr.substring(0, 200)}`;
  }

  if (name === "shell") {
    const cmd = args.command || "";
    await onLog("stdout", `[openrouter] $ ${cmd}\n`);
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...apiContext?.shellEnv } });
      const output = sanitize(stdout || "");
      if (output.trim()) await onLog("stdout", output.substring(0, 1000) + "\n");
      return output.substring(0, 50_000) || (stderr ? sanitize(stderr).substring(0, 5000) : "(no output)");
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      return sanitize((e.stderr || e.stdout || e.message || "Command failed").substring(0, 5000));
    }
  }

  if (name === "read_file") {
    try {
      const content = sanitize(await readFile(resolve(cwd, args.path || ""), "utf-8"));
      const lines = content.split("\n");
      const offset = Math.max(1, parseInt(args.offset as string) || 1);
      const limit = parseInt(args.limit as string) || 0;
      const sliced = limit > 0 ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);
      const numbered = sliced.map((line, i) => `${offset + i}\t${line}`).join("\n");
      const result = numbered.substring(0, 100_000);
      if (result.length < numbered.length) {
        return result + `\n... (truncated, ${lines.length} total lines — use offset/limit to read specific sections)`;
      }
      return result || "(empty file)";
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "write_file") {
    try {
      const fullPath = resolve(cwd, args.path || "");
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFileAsync(fullPath, args.content || "", "utf-8");
      return `Written: ${args.path}`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "edit_file") {
    try {
      const fullPath = resolve(cwd, args.path || "");
      const content = await readFile(fullPath, "utf-8");
      const oldText = args.old_text || "";
      const newText = args.new_text ?? "";
      if (!oldText) return "Error: old_text is required";
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) return `Error: old_text not found in ${args.path}. Make sure it matches exactly (including whitespace).`;
      if (occurrences > 1) return `Error: old_text found ${occurrences} times in ${args.path}. Provide a more unique text block to match exactly once.`;
      await writeFileAsync(fullPath, content.replace(oldText, newText), "utf-8");
      return `Edited: ${args.path} (replaced ${oldText.split("\n").length} lines)`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "list_directory") {
    try {
      const dirPath = resolve(cwd, args.path || ".");
      const recursive = args.recursive === "true" || (args as Record<string, unknown>).recursive === true;
      const entries: string[] = [];
      async function walk(dir: string, depth: number) {
        if (depth > 4 || entries.length > 500) return;
        const items = await readdir(dir);
        for (const item of items) {
          if (item.startsWith(".") && depth > 0) continue;
          const full = resolve(dir, item);
          const rel = relative(cwd, full);
          try {
            const st = await lstat(full);
            if (st.isDirectory()) {
              entries.push(rel + "/");
              if (recursive) await walk(full, depth + 1);
            } else {
              entries.push(rel);
            }
          } catch {}
          if (entries.length > 500) return;
        }
      }
      await walk(dirPath, 0);
      return entries.length ? entries.join("\n") : "(empty directory)";
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "web_search") {
    try {
      const q = encodeURIComponent(args.query || "");
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: { "User-Agent": "Paperclip-Agent/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const html = sanitize(await res.text());
      const links: string[] = [];
      const re = /class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
      let m;
      while ((m = re.exec(html)) && links.length < 8) {
        links.push(`${m[2].replace(/<[^>]*>/g, "").trim()}: ${m[1]}`);
      }
      return links.length ? links.join("\n") : "No results found.";
    } catch (err: unknown) {
      return `Search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "web_fetch") {
    try {
      const res = await fetch(args.url || "", {
        method: (args.method || "GET").toUpperCase(),
        headers: { "User-Agent": "Paperclip-Agent/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      return sanitize(`${res.status}\n\n${(await res.text()).substring(0, 20_000)}`);
    } catch (err: unknown) {
      return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "create_issue" && apiContext) {
    const title = args.title || "Untitled";
    const description = args.description || "";
    const assigneeName = args.assignee_agent_name || "";

    // Allow email delegation for everyone, subtask creation only for managers
    const isEmailDelegation = title.startsWith("[Email]");
    const agentNameLower = (apiContext.agentName || "").toLowerCase();
    const isManager = /^(ceo|cto|cfo|cmo)\b/.test(agentNameLower);
    if (!isEmailDelegation && !isManager) {
      return `BLOCKED: IC agents cannot create issues. Only email delegation is allowed (title must start with "[Email]"). Do the work yourself.`;
    }
    // Hermes is email-only — auto-reassign non-email tasks using keyword routing
    if (assigneeName.toLowerCase().includes("hermes") && !isEmailDelegation) {
      const ROUTING: Array<[RegExp, string]> = [
        [/security|audit|vulnerab|CVE/i, "Sentinel"],
        [/architect|design|system|refactor/i, "Winston"],
        [/code|implement|build|feature|bug|fix|engineer|index|schema/i, "Amelia"],
        [/test|QA|regression|coverage/i, "Murat"],
        [/UX|UI|wireframe|usability/i, "Sally"],
        [/tax|compliance|filing|IGIC/i, "Audra"],
        [/pricing|cost|margin|budget|financial/i, "CFO - Oro"],
        [/SEO|keyword/i, "Atlas"],
        [/content|editorial/i, "Iris"],
        [/competitor|market.*research/i, "Rex"],
        [/legal|terms|policy|contract/i, "Chaz"],
        [/document|write|spec/i, "Paige"],
        [/research|investigate|analyze/i, "Mary"],
        [/product|roadmap|prioriti/i, "John"],
      ];
      let corrected = "";
      for (const [pattern, name] of ROUTING) {
        if (pattern.test(title)) { corrected = name; break; }
      }
      if (corrected) {
        args.assignee_agent_name = corrected;
        await onLog("stdout", `[openrouter] Hermes redirect: "${title}" → ${corrected}\n`);
      }
    }

    await onLog("stdout", `[openrouter] Creating issue: ${title}${assigneeName ? ` (→ ${assigneeName})` : ""}\n`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiContext.authHeader) headers["Authorization"] = apiContext.authHeader;

      // If assignee specified, find agent ID by name
      let assigneeAgentId: string | undefined;
      if (assigneeName) {
        const agentsRes = await fetch(`http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/agents`, { headers, signal: AbortSignal.timeout(5000) });
        if (agentsRes.ok) {
          const agents = await agentsRes.json() as Array<{ id: string; name: string }>;
          const match = agents.find(a => a.name.toLowerCase().includes(assigneeName.toLowerCase()));
          if (match) assigneeAgentId = match.id;
        }
      }

      // Dedup: check if a similar open issue already exists
      const targetAgentId = assigneeAgentId || apiContext.agentId;
      if (targetAgentId) {
        try {
          const existingRes = await fetch(
            `http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/issues?assigneeAgentId=${targetAgentId}`,
            { headers, signal: AbortSignal.timeout(5000) },
          );
          if (existingRes.ok) {
            const existing = await existingRes.json() as Array<{ id: string; identifier?: string; title?: string; status?: string }>;
            const openIssues = existing.filter(i => i.status === "todo" || i.status === "in_progress" || i.status === "blocked");
            const titleWords = new Set(title.toLowerCase().split(/\s+/).filter(w => w.length > 2));
            for (const issue of openIssues) {
              if (!issue.title) continue;
              const existingWords = new Set(issue.title.toLowerCase().split(/\s+/).filter(w => w.length > 2));
              const overlap = [...titleWords].filter(w => existingWords.has(w)).length;
              const similarity = titleWords.size > 0 ? overlap / titleWords.size : 0;
              if (similarity >= 0.6) {
                await onLog("stdout", `[openrouter] Dedup: similar issue exists ${issue.identifier}\n`);
                return `Similar issue already exists: ${issue.identifier} "${issue.title}" [${issue.status}]. Add a comment to it instead of creating a duplicate.`;
              }
            }
          }
        } catch { /* dedup is best-effort */ }
      }

      const issueBody: Record<string, unknown> = { title, description, status: "todo" };
      if (assigneeAgentId) issueBody.assigneeAgentId = assigneeAgentId;
      if (apiContext.projectId) issueBody.projectId = apiContext.projectId;

      const res = await fetch(`http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/issues`, {
        method: "POST", headers, body: JSON.stringify(issueBody), signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const issue = await res.json() as { identifier?: string; id?: string };
        return `Issue created: ${issue.identifier || issue.id}${assigneeAgentId ? ` (assigned to ${assigneeName})` : ""}`;
      }
      return `Failed to create issue: ${res.status}`;
    } catch (err: unknown) {
      return `Error creating issue: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "update_issue" && apiContext) {
    const identifier = args.issue_identifier || "";
    await onLog("stdout", `[openrouter] Updating issue: ${identifier}${args.status ? ` → ${args.status}` : ""}\n`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiContext.authHeader) headers["Authorization"] = apiContext.authHeader;
      if (apiContext.runId) headers["X-Paperclip-Run-Id"] = apiContext.runId;

      const searchRes = await fetch(
        `http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/issues?identifier=${encodeURIComponent(identifier)}`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      if (!searchRes.ok) return `Failed to find issue ${identifier}: ${searchRes.status}`;
      const issues = await searchRes.json() as Array<{ id: string; identifier: string; status?: string }>;
      const issue = issues.find(i => i.identifier === identifier);
      if (!issue) return `Issue ${identifier} not found`;

      // Skip no-op updates (prevents spam notifications)
      if (args.status && issue.status === args.status && !args.title && !args.description) {
        return `Issue ${identifier} is already ${args.status} — no update needed.`;
      }

      // Checkout first to claim ownership
      await fetch(`http://localhost:${apiContext.port}/api/issues/${issue.id}/checkout`, {
        method: "POST", headers, body: JSON.stringify({ agentId: apiContext.agentId, expectedStatuses: ["todo", "in_progress", "blocked"] }), signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      const patch: Record<string, unknown> = {};
      if (args.status) patch.status = args.status;
      if (args.title) patch.title = args.title;
      if (args.description) patch.description = args.description;

      const res = await fetch(
        `http://localhost:${apiContext.port}/api/issues/${issue.id}`,
        { method: "PATCH", headers, body: JSON.stringify(patch), signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) return `Issue ${identifier} updated${args.status ? ` → ${args.status}` : ""}`;
      return `Failed to update issue ${identifier}: ${res.status}`;
    } catch (err: unknown) {
      return `Error updating issue: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "add_comment" && apiContext) {
    const identifier = args.issue_identifier || "";
    await onLog("stdout", `[openrouter] Adding comment to: ${identifier}\n`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiContext.authHeader) headers["Authorization"] = apiContext.authHeader;
      if (apiContext.runId) headers["X-Paperclip-Run-Id"] = apiContext.runId;

      const searchRes = await fetch(
        `http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/issues?identifier=${encodeURIComponent(identifier)}`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      if (!searchRes.ok) return `Failed to find issue ${identifier}: ${searchRes.status}`;
      const issues = await searchRes.json() as Array<{ id: string; identifier: string }>;
      const issue = issues.find(i => i.identifier === identifier);
      if (!issue) return `Issue ${identifier} not found`;

      // Checkout first to claim ownership
      await fetch(`http://localhost:${apiContext.port}/api/issues/${issue.id}/checkout`, {
        method: "POST", headers, body: JSON.stringify({ agentId: apiContext.agentId, expectedStatuses: ["todo", "in_progress", "blocked"] }), signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      const res = await fetch(
        `http://localhost:${apiContext.port}/api/issues/${issue.id}`,
        { method: "PATCH", headers, body: JSON.stringify({ comment: args.body || "" }), signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) return `Comment added to ${identifier}`;
      return `Failed to add comment to ${identifier}: ${res.status}`;
    } catch (err: unknown) {
      return `Error adding comment: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Memory tools (MemOS integration) ────────────────────────
  if (name === "save_memory" && apiContext) {
    const content = args.content || "";
    const category = args.category || "note";
    const tags = (args.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);
    if (!content) return "Error: content is required";
    await onLog("stdout", `[openrouter] Saving memory: ${content.substring(0, 80)}...\n`);
    try {
      const memosUrl = process.env.MEMOS_URL || "http://memos:8000";
      // Ensure agent is registered
      await fetch(`${memosUrl}/product/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: apiContext.agentId, user_name: apiContext.agentName || apiContext.agentId }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
      // Store the memory
      const metaLine = [
        category ? `[category: ${category}]` : "",
        apiContext.projectId ? `[project: ${apiContext.projectId}]` : "",
        tags.length ? `[tags: ${tags.join(", ")}]` : "",
        `[source: agent_tool]`,
      ].filter(Boolean).join("\n");
      const res = await fetch(`${memosUrl}/product/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: apiContext.agentId,
          writable_cube_ids: [apiContext.companyId],
          messages: [{ role: "assistant", content: `${content}\n${metaLine}` }],
          async_mode: "sync",
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return `Memory saved: "${content.substring(0, 100)}"`;
      return `Failed to save memory: ${res.status}`;
    } catch (err: unknown) {
      return `Error saving memory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "search_memories" && apiContext) {
    const query = args.query || "";
    if (!query) return "Error: query is required";
    await onLog("stdout", `[openrouter] Searching memories: ${query.substring(0, 80)}\n`);
    try {
      const memosUrl = process.env.MEMOS_URL || "http://memos:8000";
      const res = await fetch(`${memosUrl}/product/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          user_id: apiContext.agentId,
          readable_cube_ids: [apiContext.companyId],
          top_k: 5,
          mode: "fast",
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return "No memories found (search failed).";
      // Parse MemOS nested response: { data: { skill_mem: [{memories: [{memory, metadata}]}], ... } }
      const body = await res.json() as { data?: Record<string, unknown> };
      const results: string[] = [];
      if (body.data && typeof body.data === "object") {
        for (const [memType, val] of Object.entries(body.data)) {
          if (typeof val === "string" && val.length > 10) {
            results.push(`[${memType}] ${val}`);
          } else if (Array.isArray(val)) {
            for (const group of val) {
              const g = group as { memories?: Array<{ memory?: string; metadata?: { sources?: Array<{ content?: string }> } }> };
              for (const mem of g.memories ?? []) {
                const source = mem.metadata?.sources?.[0]?.content;
                const text = source || mem.memory || "";
                if (text.length > 10) results.push(`[${memType}] ${text}`);
              }
            }
          }
        }
      }
      if (results.length === 0) return "No relevant memories found.";
      return results.map((r, i) => `${i + 1}. ${r.substring(0, 500)}`).join("\n\n");
    } catch (err: unknown) {
      return `Error searching memories: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "send_email") {
    const to = args.to || "";
    const subject = args.subject || "";
    const body = args.body || "";
    if (!to || !subject || !body) return "Error: to, subject, and body are all required";

    const smtpHost = process.env.EMAIL_SMTP_HOST || "mail.privateemail.com";
    const smtpPort = process.env.EMAIL_SMTP_PORT || "465";
    const smtpUser = process.env.EMAIL_USERNAME || "";
    const smtpPass = process.env.EMAIL_PASSWORD || "";
    const fromAddr = process.env.EMAIL_FROM || smtpUser;

    if (!smtpUser || !smtpPass) return "Error: Email not configured (EMAIL_USERNAME/EMAIL_PASSWORD missing)";

    await onLog("stdout", `[openrouter] Sending email to ${to}: ${subject}\n`);

    // Build attachment args for the Python script
    const attachmentPaths: string[] = [];
    if (args.attachments) {
      for (const p of args.attachments.split(",").map((s: string) => s.trim()).filter(Boolean)) {
        attachmentPaths.push(resolve(cwd, p));
      }
    }

    // Use Python's smtplib for reliable HTML email with attachments
    const pyScript = `
import smtplib, sys, os, mimetypes, base64
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

msg = MIMEMultipart('mixed')
msg['From'] = ${JSON.stringify(fromAddr)}
msg['To'] = ${JSON.stringify(to)}
msg['Subject'] = ${JSON.stringify(subject)}
${args.cc ? `msg['Cc'] = ${JSON.stringify(args.cc)}` : ""}
${args.reply_to ? `msg['Reply-To'] = ${JSON.stringify(args.reply_to)}` : ""}

body_raw = ${JSON.stringify(body)}

import re

def md_to_html(text):
    """Convert markdown to HTML — handles headings, bold, italic, lists, tables, hr, links, paragraphs."""
    lines = text.split('\\n')
    html_lines = []
    in_ul = False
    in_table = False
    in_p = False

    for line in lines:
        stripped = line.strip()

        # Close open lists/tables if line doesn't continue them
        if in_ul and not stripped.startswith(('- ', '* ', '• ')):
            html_lines.append('</ul>')
            in_ul = False
        if in_table and not stripped.startswith('|'):
            html_lines.append('</table>')
            in_table = False

        # Horizontal rule
        if stripped in ('---', '***', '___'):
            if in_p: html_lines.append('</p>'); in_p = False
            html_lines.append('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">')
            continue

        # Headings
        m = re.match(r'^(#{1,3})\\s+(.+)', stripped)
        if m:
            if in_p: html_lines.append('</p>'); in_p = False
            level = len(m.group(1))
            sizes = {1: '24px', 2: '20px', 3: '16px'}
            html_lines.append(f'<h{level} style="color:#1a1a1a;font-size:{sizes[level]};margin:20px 0 8px">{m.group(2)}</h{level}>')
            continue

        # Table rows
        if stripped.startswith('|') and stripped.endswith('|'):
            cells = [c.strip() for c in stripped.strip('|').split('|')]
            if all(re.match(r'^[-:]+$', c) for c in cells):
                continue  # separator row
            if not in_table:
                html_lines.append('<table style="border-collapse:collapse;width:100%;margin:12px 0">')
                in_table = True
                tag = 'th'
            else:
                tag = 'td'
            style = 'border:1px solid #ddd;padding:8px;text-align:left'
            if tag == 'th': style += ';background:#f5f5f5;font-weight:600'
            row = ''.join(f'<{tag} style="{style}">{c}</{tag}>' for c in cells)
            html_lines.append(f'<tr>{row}</tr>')
            continue

        # Bullet lists
        m = re.match(r'^[-*•]\\s+(.+)', stripped)
        if m:
            if in_p: html_lines.append('</p>'); in_p = False
            if not in_ul:
                html_lines.append('<ul style="margin:8px 0;padding-left:24px">')
                in_ul = True
            html_lines.append(f'<li style="margin:4px 0">{m.group(1)}</li>')
            continue

        # Empty line = paragraph break
        if not stripped:
            if in_p: html_lines.append('</p>'); in_p = False
            continue

        # Regular text → paragraph
        if not in_p:
            html_lines.append('<p style="margin:8px 0;line-height:1.6">')
            in_p = True
        else:
            html_lines.append('<br>')
        html_lines.append(stripped)

    if in_ul: html_lines.append('</ul>')
    if in_table: html_lines.append('</table>')
    if in_p: html_lines.append('</p>')

    result = '\\n'.join(html_lines)
    # Inline formatting
    result = re.sub(r'\\*\\*(.+?)\\*\\*', r'<strong>\\1</strong>', result)
    result = re.sub(r'\\*(.+?)\\*', r'<em>\\1</em>', result)
    result = re.sub(r'\x60(.+?)\x60', r'<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:0.9em">\\1</code>', result)
    result = re.sub(r'\\[([^\\]]+)\\]\\(([^)]+)\\)', r'<a href="\\2" style="color:#2563eb">\\1</a>', result)
    return result

# Auto-detect: if it looks like markdown (has # headings, ** bold, - lists), convert it
if '<html' in body_raw.lower() or '<body' in body_raw.lower():
    body_html = body_raw
elif re.search(r'^#{1,3}\\s|\\*\\*|^[-*]\\s|^\\|', body_raw, re.MULTILINE):
    body_html = md_to_html(body_raw)
else:
    body_html = md_to_html(body_raw)

body_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;max-width:680px;margin:0 auto;padding:20px">
{body_html}
</body></html>"""
msg.attach(MIMEText(body_html, 'html', 'utf-8'))

attachments = ${JSON.stringify(attachmentPaths)}
for filepath in attachments:
    if not os.path.isfile(filepath):
        print(f"Warning: attachment not found: {filepath}", file=sys.stderr)
        continue
    ctype, _ = mimetypes.guess_type(filepath)
    maintype, subtype = (ctype or 'application/octet-stream').split('/')
    with open(filepath, 'rb') as f:
        part = MIMEBase(maintype, subtype)
        part.set_payload(f.read())
    encoders.encode_base64(part)
    part.add_header('Content-Disposition', 'attachment', filename=os.path.basename(filepath))
    msg.attach(part)

all_recipients = [a.strip() for a in msg['To'].split(',')]
if msg.get('Cc'): all_recipients += [a.strip() for a in msg['Cc'].split(',')]
${args.bcc ? `all_recipients += [a.strip() for a in ${JSON.stringify(args.bcc)}.split(',')]` : ""}

try:
    server = smtplib.SMTP_SSL(${JSON.stringify(smtpHost)}, ${JSON.stringify(parseInt(smtpPort))}, timeout=30)
    server.login(${JSON.stringify(smtpUser)}, ${JSON.stringify(smtpPass)})
    server.sendmail(${JSON.stringify(fromAddr)}, all_recipients, msg.as_string())
    server.quit()
    print(f"Email sent successfully to {msg['To']}")
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;

    try {
      const { stdout, stderr } = await execAsync(`python3 -c ${JSON.stringify(pyScript)}`, {
        cwd,
        encoding: "utf-8",
        timeout: 60_000,
        env: process.env as Record<string, string>,
      });
      const output = (stdout || "").trim();
      if (output) await onLog("stdout", `[openrouter] ${output}\n`);
      return output || "Email sent successfully";
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const errMsg = (e.stderr || e.message || "Failed to send email").trim();
      await onLog("stderr", `[openrouter] Email error: ${errMsg}\n`);
      return `Error sending email: ${errMsg}`;
    }
  }

  return `Unknown tool: ${name}`;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  timeoutMs: number,
) {
  const body: Record<string, unknown> = { model, messages, max_tokens: 16384, temperature: 0.2 };
  if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://paperclip.ing",
      "X-Title": "Paperclip Agent",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).substring(0, 300)}`);

  const data = await res.json() as {
    choices: Array<{ message: ChatMessage }>;
    usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
    model?: string;
  };

  // Prefer cost from response body (usage.cost), fall back to header for older API versions
  const bodyCost = typeof data.usage?.cost === "number" ? data.usage.cost : 0;
  const headerCost = parseFloat(res.headers.get("x-openrouter-cost") || "0") || 0;

  return {
    message: data.choices?.[0]?.message || { role: "assistant" as const, content: "" },
    usage: data.usage,
    cost: bodyCost || headerCost,
    model: data.model,
  };
}

function isQuotaOrRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return /429|rate.?limit|quota|resource.?exhausted|capacity|overloaded|too many requests|credits/i.test(lower);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn } = ctx;
  const startedAt = Date.now();
  const defaultModel = asString(config.model, DEFAULT_OPENROUTER_MODEL);
  const heartbeatModel = asString(config.heartbeatModel, defaultModel);
  const complexModel = asString(config.complexModel, defaultModel);
  const timeoutSec = asNumber(config.timeoutSec, 600);
  const maxTurns = asNumber(config.maxTurns, 30);
  const maxChainIssues = asNumber(config.maxChainIssues, 5);
  // Per-model-type fallbacks — set via UI dropdowns
  const fallbackModel = asString(config.fallbackModel, "");
  const fallbackHeartbeatModel = asString(config.fallbackHeartbeatModel, fallbackModel);
  const fallbackComplexModel = asString(config.fallbackComplexModel, fallbackModel);

  // Model will be selected after we know the task context
  let model = defaultModel;

  // ── Resolve workspace CWD (same pattern as claude_local) ───
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || agentHome || configuredCwd || `/tmp/paperclip-agent-${agent.id}`;
  try { await ensureAbsoluteDirectory(cwd, { createIfMissing: true }); } catch {}

  // ── Resolve project workspace paths ────────────────────────
  const projectWorkspaces: string[] = [];
  const rawWorkspaces = context.paperclipWorkspaces;
  if (Array.isArray(rawWorkspaces)) {
    for (const ws of rawWorkspaces) {
      const wsCwd = asString((ws as Record<string, unknown>)?.cwd, "");
      if (wsCwd && wsCwd !== cwd) projectWorkspaces.push(wsCwd);
    }
  }

  // ── Resolve API key ────────────────────────────────────────
  const envConfig = parseObject(config.env);
  let apiKey = "";
  for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) {
    const v = envConfig[k];
    if (typeof v === "string" && v) { apiKey = v; break; }
  }
  if (!apiKey) apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: "OPENROUTER_API_KEY not set", errorCode: "openrouter_no_api_key" };
  }

  // ── Load agent instructions ────────────────────────────────
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  let agentInstructions = "";
  if (instructionsFilePath) {
    try { agentInstructions = sanitize(await readFile(instructionsFilePath, "utf-8")); } catch (err) {
      await onLog("stderr", `[openrouter] Warning: could not read instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // ── Sync skills to disk ─────────────────────────────────────
  // Skills are managed via the UI's Skills tab (syncSkills in skills.ts).
  // Here we just ensure symlinks are current for this run.
  const runtimeSkills = Array.isArray(config.paperclipRuntimeSkills) ? config.paperclipRuntimeSkills as Array<{ key: string; runtimeName: string; source: string; required?: boolean }> : [];
  const desiredSkillsRaw = config.desiredSkills;
  const desiredSkills = new Set<string>(["paperclip"]); // always include core
  if (Array.isArray(desiredSkillsRaw)) {
    for (const s of desiredSkillsRaw) {
      if (typeof s === "string" && s.trim()) desiredSkills.add(s.trim());
    }
  }
  // Also include required skills
  for (const skill of runtimeSkills) {
    if (skill.required) desiredSkills.add(skill.key);
  }
  // Read desired skills from the sync preference (set by UI Skills tab)
  const syncPref = config.paperclipSkillSync as Record<string, unknown> | undefined;
  if (syncPref && Array.isArray(syncPref.desiredSkills)) {
    for (const s of syncPref.desiredSkills) {
      if (typeof s === "string" && s.trim()) desiredSkills.add(s.trim());
    }
  }
  const skillsDir = resolve(cwd, ".skills");
  let syncedSkillCount = 0;
  try {
    await mkdir(skillsDir, { recursive: true });
    // Remove stale symlinks
    const existing = await readdir(skillsDir).catch(() => [] as string[]);
    for (const name of existing) {
      const link = resolve(skillsDir, name);
      try {
        await readlink(link);
        await unlink(link);
      } catch { /* not a symlink — leave it */ }
    }
    // Create symlinks for desired skills
    for (const skill of runtimeSkills) {
      if (!skill.source) continue;
      // Match by runtimeName, key, or slug (runtimeName may have --hash suffix)
      const slug = skill.runtimeName.replace(/--[a-f0-9]+$/, "");
      if (!desiredSkills.has(skill.runtimeName) && !desiredSkills.has(skill.key) && !desiredSkills.has(slug)) continue;
      try {
        await symlink(skill.source, resolve(skillsDir, skill.runtimeName));
        syncedSkillCount++;
      } catch { /* symlink failed — skip */ }
    }
    if (syncedSkillCount > 0) {
      await onLog("stdout", `[openrouter] Synced ${syncedSkillCount} skill(s) to .skills/\n`);
    }
  } catch {
    // Skills dir creation failed — continue without skills
  }

  // ── Build prompt ───────────────────────────────────────────
  const promptTemplate = asString(config.promptTemplate, "You are {{agent.name}}. Complete assigned tasks efficiently.");
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = { agentId: agent.id, companyId: agent.companyId, runId, agent, context, company: { id: agent.companyId }, run: { id: runId } };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrap = bootstrapPromptTemplate ? renderTemplate(bootstrapPromptTemplate, templateData) : "";

  // ── Extract issue context ──────────────────────────────────
  const issueId = asString(context.issueId || context.taskId, "");
  const wakeReason = asString(context.wakeReason, "");
  let issueBlock = "";
  let jwtAuthHeader = "";
  // ── Generate JWT for internal API access ────────────────────
  try {
    const port = process.env.PORT || "3100";
    const jwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    if (jwtSecret) {
      const { createHmac } = await import("node:crypto");
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: agent.id,
        company_id: agent.companyId,
        adapter_type: "openrouter_local",
        run_id: runId,
        iss: "paperclip",
        aud: "paperclip-api",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + Math.max(600, timeoutSec + 60),
      })).toString("base64url");
      const sig = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
      jwtAuthHeader = `Bearer ${header}.${payload}.${sig}`;
    }
  } catch {}

  // ── Discover plugin tools ──��────────────────────────────────
  const port = process.env.PORT || "3100";
  let pluginTools: PluginToolDescriptor[] = [];
  const pluginToolNameMap = new Map<string, string>(); // normalized name → namespaced name
  if (jwtAuthHeader) {
    pluginTools = await discoverPluginTools(port, jwtAuthHeader);
    for (const pt of pluginTools) {
      pluginToolNameMap.set(pt.name.replace(/[.:]/g, "_"), pt.name);
    }
    if (pluginTools.length > 0) {
      await onLog("stdout", `[openrouter] Discovered ${pluginTools.length} plugin tool(s): ${pluginTools.map(t => t.displayName).join(", ")}\n`);
    }
  }
  const allTools: ToolDefinition[] = [
    ...AGENT_TOOLS,
    ...pluginTools.map(pluginToolToDefinition),
  ];

  // ── Fetch issue context ────────────────────────────────────
  let issueProjectId: string | undefined;
  if (issueId) {
    try {
      const port = process.env.PORT || "3100";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtAuthHeader) headers["Authorization"] = jwtAuthHeader;

      {
      const res = await fetch(`http://localhost:${port}/api/issues/${issueId}`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const issue = await res.json() as { title?: string; description?: string; identifier?: string; status?: string; projectId?: string };

        // Skip cancelled/done/blocked issues — don't work on them
        if (issue.status === "cancelled" || issue.status === "done" || issue.status === "blocked") {
          await onLog("stdout", `[openrouter] Task ${issue.identifier} is ${issue.status} — skipping\n`);
          return { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 0, outputTokens: 0 }, summary: `Skipped ${issue.identifier} — ${issue.status}` };
        }

        if (issue.projectId) issueProjectId = issue.projectId;
        issueBlock = `\n## ASSIGNED TASK: ${issue.identifier || ""} ${issue.title || ""}\n${issue.description || ""}`;
        await onLog("stdout", `[openrouter] Task: ${issue.identifier} ${issue.title}\n`);

        // ── Check for existing subtasks ─────────────────────
        // If this issue has been decomposed into subtasks, tell the agent to coordinate, not redo the work
        try {
          const childRes = await fetch(
            `http://localhost:${port}/api/companies/${agent.companyId}/issues?parentId=${issueId}`,
            { headers, signal: AbortSignal.timeout(5000) },
          );
          if (childRes.ok) {
            const children = await childRes.json() as Array<{ identifier?: string; title?: string; status?: string; assigneeAgentId?: string }>;
            if (children.length > 0) {
              const openChildren = children.filter(c => c.status !== "done" && c.status !== "cancelled");
              const allDone = openChildren.length === 0;
              const childList = children.map(c => `- ${c.identifier} ${c.title} [${c.status}]`).join("\n");
              if (allDone) {
                // All subtasks complete — agent should synthesize findings and close
                issueBlock += `\n\n## ALL SUBTASKS ARE COMPLETE\n${childList}\n\nAll subtasks are done. Your job:\n1. Read the work output from each subtask (check comments, workspace files)\n2. Write a final summary combining all findings as a comment on THIS issue using add_comment\n3. Re-read the original task description above — if it asks for follow-up actions (e.g. sending an email, creating a document), do them now. To send an email, create an issue titled "[Email] ..." and assign it to Hermes.\n4. Mark this issue as done using update_issue`;
                await onLog("stdout", `[openrouter] All ${children.length} subtask(s) complete — synthesis mode\n`);
              } else {
                const openList = openChildren.map(c => `- ${c.identifier} ${c.title} [${c.status}]`).join("\n");
                issueBlock += `\n\n## THIS TASK HAS BEEN DECOMPOSED INTO SUBTASKS\nDo NOT do the work yourself. The following subtasks are still in progress:\n${openList}\n\nDo NOT mark this issue as done — subtasks are still being worked on.\nYour only job: update_issue with a brief status summary of subtask progress, then stop.`;
                await onLog("stdout", `[openrouter] Task has ${openChildren.length} open subtask(s) — coordination mode\n`);
              }
            }
          }
        } catch { /* best effort */ }

        // ── Fetch related/referenced issues ──────────────────
        // Scan description for patterns like "Related: ANI-100, ANI-131" or "See: ANI-100" or "Context: ANI-100"
        const desc = issue.description || "";
        const refPattern = /(?:Related|See|Context|Reference|Ref|Background):\s*((?:[A-Z]+-\d+(?:\s*,\s*)?)+)/gi;
        const mentionPattern = /\[([A-Z]+-\d+)\]/g;
        const relatedIds = new Set<string>();
        let refMatch;
        while ((refMatch = refPattern.exec(desc))) {
          for (const id of refMatch[1].split(",").map(s => s.trim()).filter(Boolean)) {
            if (/^[A-Z]+-\d+$/.test(id)) relatedIds.add(id);
          }
        }
        while ((refMatch = mentionPattern.exec(desc))) {
          relatedIds.add(refMatch[1]);
        }
        // Remove self-reference
        if (issue.identifier) relatedIds.delete(issue.identifier);

        if (relatedIds.size > 0) {
          const relatedBlocks: string[] = [];
          for (const refId of relatedIds) {
            try {
              const refRes = await fetch(`http://localhost:${port}/api/issues/${refId}`, { headers, signal: AbortSignal.timeout(3000) });
              if (refRes.ok) {
                const refIssue = await refRes.json() as { title?: string; description?: string; identifier?: string; status?: string };
                relatedBlocks.push(`### ${refIssue.identifier} ${refIssue.title} [${refIssue.status}]\n${(refIssue.description || "").substring(0, 3000)}`);
                await onLog("stdout", `[openrouter] Related: ${refIssue.identifier} ${refIssue.title}\n`);
              }
            } catch {}
          }
          if (relatedBlocks.length > 0) {
            issueBlock += `\n\n## RELATED ISSUES (for context — do NOT work on these, just use them for background)\n${relatedBlocks.join("\n\n")}`;
          }
        }
      }
      }
    } catch {}
  }



  // onMeta is called after model selection (below) so it reports the correct model

  // ── Build system prompt ────────────────────────────────────
  const systemParts: string[] = [];
  if (agentInstructions) systemParts.push(agentInstructions);
  systemParts.push(
    `You are an AI agent in Paperclip. Your workspace directory is: ${cwd}`,
    ...(projectWorkspaces.length > 0
      ? [`Project source code directories: ${projectWorkspaces.join(", ")}. Use these paths when the task involves project code.`]
      : []),
    `You have tools: shell, read_file (with offset/limit for large files), write_file, edit_file (search/replace for surgical edits), list_directory, web_search, web_fetch, create_issue, update_issue, add_comment, save_memory, search_memories, send_email (HTML emails with attachments).${pluginTools.length > 0 ? ` Plugin tools: ${pluginTools.map(t => `${t.name.replace(/[.:]/g, "_")} (${t.description.substring(0, 80)})`).join(", ")}.` : ""}`,
    "PREFER edit_file over write_file when modifying existing files — it's faster and safer than rewriting entire files.",
    "",
    "RULES (in priority order):",
    "1. ISSUE STATUS IS MANDATORY: Before your run ends, you MUST call update_issue to set status (in_progress, done, or blocked). A run that does work but leaves the issue in 'todo' is a FAILED run. This is your #1 obligation.",
    "2. Stay focused on the assigned task. Do the actual work — do NOT create planning issues, coordination issues, progress check issues, or follow-up issues. Just do the work yourself.",
    "3. ONLY create new issues when explicitly delegating email to Hermes (title '[Email] subject'). Do NOT create subtasks, follow-up tasks, or backlog items on your own initiative.",
    "4. NEVER create duplicate issues. NEVER create issues based on old reports or files in your workspace. If something was already done, leave it alone.",
    "5. EMAILS: Use the send_email tool for all outbound emails. Always use HTML formatting (tables, headings, styled text). You can attach workspace files. Never delegate email via issue creation — send it directly.",
    "6. ONLY operate within your workspace directory. Do NOT explore /app or other system directories.",
    "7. Use minimal tool calls. When done, call update_issue(status='done'), then add_comment with a summary, then STOP.",
    "8. For heartbeats without a task, report status briefly and stop. If you have assigned tasks, WORK ON THEM — do not just report status.",
  );

  // Point agent to skills directory (if any were synced)
  if (syncedSkillCount > 0) {
    systemParts.push(`You have ${syncedSkillCount} skill(s) in .skills/ — each is a directory containing a SKILL.md with domain knowledge. Use list_directory and read_file to consult them when the task requires specialized knowledge.`);
  }

  // ── Fetch assigned issues if no explicit task ──────────────
  // When there's no issueId in context (heartbeat/on_demand), check for
  // assigned issues so agents don't ignore pending work.
  let assignedIssuesBlock = "";
  const assignedIssueIds: Array<{ id: string; identifier: string; status: string; title: string; description: string; parentId?: string; isSynthesis: boolean }> = [];
  let hasSubtaskAssigned = false;
  if (!issueId && jwtAuthHeader) {
    try {
      const port = process.env.PORT || "3100";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      headers["Authorization"] = jwtAuthHeader;
      const assignedRes = await fetch(
        `http://localhost:${port}/api/companies/${agent.companyId}/issues?assigneeAgentId=${agent.id}`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      if (assignedRes.ok) {
        const allAssigned = await assignedRes.json() as Array<{ id?: string; identifier?: string; title?: string; status?: string; description?: string; parentId?: string }>;
        const pending = allAssigned.filter(i => i.status === "todo" || i.status === "in_progress");
        // Check subtasks for each assigned issue to determine mode
        const assigned: typeof pending = [];
        const synthesisIds = new Set<string>(); // parent issues with all subtasks done — need synthesis
        for (const i of pending) {
          if (i.id) {
            try {
              const childRes = await fetch(
                `http://localhost:${port}/api/companies/${agent.companyId}/issues?parentId=${i.id}`,
                { headers, signal: AbortSignal.timeout(3000) },
              );
              if (childRes.ok) {
                const children = await childRes.json() as Array<{ identifier?: string; title?: string; status?: string }>;
                if (children.length > 0) {
                  const hasOpen = children.some(c => c.status !== "done" && c.status !== "cancelled");
                  if (hasOpen) {
                    await onLog("stdout", `[openrouter] Skipping ${i.identifier} from heartbeat — has open subtasks\n`);
                    continue;
                  }
                  // All subtasks done — include for synthesis
                  synthesisIds.add(i.identifier || "");
                }
              }
            } catch { /* best effort — include it */ }
          }
          assigned.push(i);
        }
        if (assigned.length > 0) {
          for (const i of assigned) {
            if (i.id && i.identifier && i.status) assignedIssueIds.push({ id: i.id, identifier: i.identifier, status: i.status, title: i.title || "", description: i.description || "", parentId: i.parentId || undefined, isSynthesis: synthesisIds.has(i.identifier || "") });
            if (i.parentId) hasSubtaskAssigned = true;
          }
          // Prioritise synthesis tasks — put them first
          const synthesisIssues = assigned.filter(i => synthesisIds.has(i.identifier || ""));
          const regularIssues = assigned.filter(i => !synthesisIds.has(i.identifier || ""));
          if (synthesisIssues.length > 0) {
            const synthLines = synthesisIssues.map(
              (i) => `- **${i.identifier}** ${i.title} — ALL SUBTASKS COMPLETE, needs synthesis`
            );
            const regularLines = regularIssues.slice(0, 3).map(
              (i) => `- **${i.identifier}** ${i.title} [${i.status}]${i.description ? `: ${i.description.substring(0, 200)}` : ""}`
            );
            assignedIssuesBlock = `\n## PRIORITY: SYNTHESISE COMPLETED SUBTASKS\nThe following parent issue(s) have ALL subtasks done. Pick the first one and:\n1. Read work output from each subtask (check comments, workspace files)\n2. Write a final summary combining all findings as a comment using add_comment\n3. Re-read the original task description — if it asks for follow-up actions (e.g. sending an email), do them now. To send an email, create an issue titled "[Email] ..." and assign it to Hermes.\n4. Mark the issue as done using update_issue\n${synthLines.join("\n")}`;
            if (regularLines.length > 0) {
              assignedIssuesBlock += `\n\n## OTHER ASSIGNED ISSUES\n${regularLines.join("\n")}`;
            }
          } else {
            const lines = assigned.slice(0, 3).map(
              (i) => `- **${i.identifier}** ${i.title} [${i.status}]${i.description ? `: ${i.description.substring(0, 200)}` : ""}`
            );
            assignedIssuesBlock = `\n## YOUR ASSIGNED ISSUES (${assigned.length} open)\nPick ONE issue and make direct progress on it. Do NOT create new issues, subtasks, or plans — just do the actual work on the existing issue.\n${lines.join("\n")}`;
          }
          await onLog("stdout", `[openrouter] Found ${assigned.length} assigned issue(s)\n`);
        }
      }
    } catch {
      // Best effort
    }
  }

  // ── Build chain queue for heartbeat runs ─────────────────
  // For heartbeat runs with assigned issues, chain through them sequentially.
  // For direct-assignment runs (issueId set), no chaining — single issue.
  const chainQueue = (!issueId && assignedIssueIds.length > 0)
    ? assignedIssueIds.slice(0, maxChainIssues)
    : [];
  const isChainedRun = chainQueue.length > 1;
  let globalTurn = 0;
  const chainSummaries: string[] = [];

  if (isChainedRun) {
    await onLog("stdout", `[openrouter] Chaining ${chainQueue.length} issues in this run\n`);
  }

  // ══════════════════════════════════════════════════════════
  // ── Issue chain loop ──────────────────────────────────────
  // For heartbeat runs with multiple assigned issues, chain through them
  // sequentially in a single run. For direct-assignment or pure heartbeat
  // runs, the loop executes exactly once — zero behavior change.
  // ══════════════════════════════════════════════════════════
  const chainIterations = chainQueue.length > 0 ? chainQueue.length : 1;
  let totalIn = 0, totalOut = 0, totalCost = 0, lastMessage = "";
  let resolvedModel = model;
  let chainTimedOut = false;
  let chainErrorMessage: string | undefined;

  for (let chainIdx = 0; chainIdx < chainIterations; chainIdx++) {
    // ── Check shared budgets before starting next issue ──────
    if (globalTurn >= maxTurns) {
      await onLog("stdout", `[openrouter] Chain: turn budget exhausted (${globalTurn}/${maxTurns}), stopping\n`);
      break;
    }
    if (Date.now() - startedAt > timeoutSec * 1000) {
      await onLog("stdout", `[openrouter] Chain: timeout reached, stopping\n`);
      chainTimedOut = true;
      break;
    }

    // ── Determine current issue for this chain iteration ─────
    const chainIssue = chainQueue[chainIdx]; // undefined for non-chaining runs
    const currentIssueId = chainIssue?.id || issueId;
    let currentIssueProjectId: string | undefined = issueProjectId;
    let currentIssueBlock = issueBlock;

    if (isChainedRun && chainIssue) {
      await onLog("stdout", `[openrouter] Chain ${chainIdx + 1}/${chainQueue.length}: ${chainIssue.identifier} ${chainIssue.title}\n`);

      // Fetch full issue context for this chain iteration
      currentIssueBlock = "";
      try {
        const port = process.env.PORT || "3100";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (jwtAuthHeader) headers["Authorization"] = jwtAuthHeader;
        const res = await fetch(`http://localhost:${port}/api/issues/${chainIssue.id}`, { headers, signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const issue = await res.json() as { title?: string; description?: string; identifier?: string; status?: string; projectId?: string };
          // Skip done/cancelled/blocked issues
          if (issue.status === "cancelled" || issue.status === "done" || issue.status === "blocked") {
            await onLog("stdout", `[openrouter] Skipping ${issue.identifier} — ${issue.status}\n`);
            continue;
          }
          if (issue.projectId) currentIssueProjectId = issue.projectId;
          currentIssueBlock = `\n## ASSIGNED TASK: ${issue.identifier || ""} ${issue.title || ""}\n${issue.description || ""}`;

          // Check for subtasks (coordination/synthesis mode)
          try {
            const childRes = await fetch(`http://localhost:${port}/api/companies/${agent.companyId}/issues?parentId=${chainIssue.id}`, { headers, signal: AbortSignal.timeout(5000) });
            if (childRes.ok) {
              const children = await childRes.json() as Array<{ identifier?: string; title?: string; status?: string }>;
              if (children.length > 0) {
                const openChildren = children.filter(c => c.status !== "done" && c.status !== "cancelled");
                const allDone = openChildren.length === 0;
                const childList = children.map(c => `- ${c.identifier} ${c.title} [${c.status}]`).join("\n");
                if (allDone) {
                  currentIssueBlock += `\n\n## ALL SUBTASKS ARE COMPLETE\n${childList}\n\nAll subtasks are done. Your job:\n1. Read the work output from each subtask (check comments, workspace files)\n2. Write a final summary combining all findings as a comment on THIS issue using add_comment\n3. Re-read the original task description above — if it asks for follow-up actions (e.g. sending an email, creating a document), do them now. To send an email, create an issue titled "[Email] ..." and assign it to Hermes.\n4. Mark this issue as done using update_issue`;
                } else {
                  const openList = openChildren.map(c => `- ${c.identifier} ${c.title} [${c.status}]`).join("\n");
                  currentIssueBlock += `\n\n## THIS TASK HAS BEEN DECOMPOSED INTO SUBTASKS\nDo NOT do the work yourself. The following subtasks are still in progress:\n${openList}\n\nDo NOT mark this issue as done — subtasks are still being worked on.\nYour only job: update_issue with a brief status summary of subtask progress, then stop.`;
                }
              }
            }
          } catch { /* best effort */ }

          // Fetch related issues
          const desc = issue.description || "";
          const refPattern = /(?:Related|See|Context|Reference|Ref|Background):\s*((?:[A-Z]+-\d+(?:\s*,\s*)?)+)/gi;
          const mentionPattern = /\[([A-Z]+-\d+)\]/g;
          const relatedIds = new Set<string>();
          let refMatch;
          while ((refMatch = refPattern.exec(desc))) {
            for (const id of refMatch[1].split(",").map(s => s.trim()).filter(Boolean)) {
              if (/^[A-Z]+-\d+$/.test(id)) relatedIds.add(id);
            }
          }
          while ((refMatch = mentionPattern.exec(desc))) {
            relatedIds.add(refMatch[1]);
          }
          if (issue.identifier) relatedIds.delete(issue.identifier);
          if (relatedIds.size > 0) {
            for (const relId of relatedIds) {
              try {
                const relRes = await fetch(`http://localhost:${port}/api/companies/${agent.companyId}/issues?identifier=${encodeURIComponent(relId)}`, { headers, signal: AbortSignal.timeout(3000) });
                if (relRes.ok) {
                  const relIssues = await relRes.json() as Array<{ identifier?: string; title?: string; description?: string; status?: string }>;
                  const rel = relIssues.find(r => r.identifier === relId);
                  if (rel) {
                    currentIssueBlock += `\n\n### Related: ${rel.identifier} ${rel.title || ""} [${rel.status}]\n${(rel.description || "").substring(0, 500)}`;
                  }
                }
              } catch { /* best effort */ }
            }
          }
        }
      } catch { /* best effort — use minimal context */ }
    }

    // ── Select model for this issue ───────────────────────────
    let iterationModel = defaultModel;
    if (isChainedRun && chainIssue) {
      if (chainIssue.isSynthesis) {
        iterationModel = complexModel;
        await onLog("stdout", `[openrouter] Model: ${iterationModel} (complex, synthesis)\n`);
      } else if (chainIssue.parentId) {
        iterationModel = complexModel;
        await onLog("stdout", `[openrouter] Model: ${iterationModel} (complex, subtask)\n`);
      } else {
        const scoreMatch = chainIssue.description.match(/complexity:\s*(\d+)\/10/i);
        if (scoreMatch && parseInt(scoreMatch[1], 10) >= 7) {
          iterationModel = complexModel;
          await onLog("stdout", `[openrouter] Model: ${iterationModel} (complex, triage ${scoreMatch[1]})\n`);
        } else {
          await onLog("stdout", `[openrouter] Model: ${iterationModel} (standard)\n`);
        }
      }
    } else if (!issueId && !assignedIssuesBlock) {
      iterationModel = heartbeatModel;
      await onLog("stdout", `[openrouter] Model: ${iterationModel} (heartbeat)\n`);
    } else if (!issueId && hasSubtaskAssigned) {
      iterationModel = complexModel;
      await onLog("stdout", `[openrouter] Model: ${iterationModel} (complex, assigned subtask)\n`);
    } else if (issueId && issueBlock) {
      try {
        const port = process.env.PORT || "3100";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (jwtAuthHeader) headers["Authorization"] = jwtAuthHeader;
        const issueRes = await fetch(`http://localhost:${port}/api/issues/${issueId}`, { headers, signal: AbortSignal.timeout(5000) });
        if (issueRes.ok) {
          const issueData = await issueRes.json() as { parentId?: string; description?: string; comments?: Array<{ body?: string }> };
          if (issueData.parentId) {
            iterationModel = complexModel;
            await onLog("stdout", `[openrouter] Model: ${iterationModel} (complex, subtask of decomposed parent)\n`);
          } else {
            const allText = (issueData.description ?? "") + " " + (issueData.comments ?? []).map(c => c.body ?? "").join(" ");
            const scoreMatch = allText.match(/complexity:\s*(\d+)\/10/i);
            if (scoreMatch && parseInt(scoreMatch[1], 10) >= 7) {
              iterationModel = complexModel;
              await onLog("stdout", `[openrouter] Model: ${iterationModel} (complex, triage score ${scoreMatch[1]})\n`);
            } else {
              await onLog("stdout", `[openrouter] Model: ${iterationModel} (standard${scoreMatch ? `, triage score ${scoreMatch[1]}` : ""})\n`);
            }
          }
        }
      } catch {
        await onLog("stdout", `[openrouter] Model: ${iterationModel} (standard)\n`);
      }
    } else {
      await onLog("stdout", `[openrouter] Model: ${iterationModel} (standard)\n`);
    }
    model = iterationModel;

    if (onMeta && chainIdx === 0) {
      await onMeta({ adapterType: "openrouter_local", command: "openrouter-api", cwd, commandNotes: [`Model: ${model}`], prompt: renderedPrompt });
    }

    // ── Inject memories from MemOS (per-issue) ─────────────────
    let memoryBlock = "";
    if (jwtAuthHeader && (currentIssueId || assignedIssuesBlock)) {
      try {
        const memosUrl = process.env.MEMOS_URL || "http://memos:8000";
        const memQuery = currentIssueBlock
          ? currentIssueBlock.substring(0, 500)
          : assignedIssuesBlock.substring(0, 500);
        const memRes = await fetch(`${memosUrl}/product/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: memQuery,
            user_id: agent.id,
            readable_cube_ids: [agent.companyId],
            top_k: 5,
            mode: "fast",
          }),
          signal: AbortSignal.timeout(3000),
        });
        if (memRes.ok) {
          // MemOS returns { data: { skill_mem: [{memories: [{memory: "..."}]}], text_mem: [...], pref_note: "...", ... } }
          const memBody = await memRes.json() as { data?: Record<string, unknown> };
          const snippets: string[] = [];
          if (memBody.data && typeof memBody.data === "object") {
            for (const [, val] of Object.entries(memBody.data)) {
              if (typeof val === "string" && val.length > 10) {
                snippets.push(val); // pref_note
              } else if (Array.isArray(val)) {
                for (const group of val) {
                  const g = group as { memories?: Array<{ memory?: string; metadata?: { sources?: Array<{ content?: string }> } }> };
                  for (const mem of g.memories ?? []) {
                    // Use source content if available (richer), otherwise the summary
                    const source = mem.metadata?.sources?.[0]?.content;
                    const text = source || mem.memory || "";
                    if (text.length > 10) snippets.push(text);
                  }
                }
              }
            }
          }
          if (snippets.length > 0) {
            memoryBlock = "\n## RELEVANT CONTEXT FROM PREVIOUS RUNS\nUse this context if relevant to the current task. Use search_memories for more.\n" +
              snippets.slice(0, 5).map((s) => `- ${s.substring(0, 500)}`).join("\n");
            await onLog("stdout", `[openrouter] Injected ${snippets.length} memories\n`);
          }
        }
      } catch { /* best effort */ }
    }

    // ── Build messages for this issue ────────────────────────
    const userParts: string[] = [];
    if (renderedBootstrap) userParts.push(renderedBootstrap);
    userParts.push(renderedPrompt);
    if (isChainedRun && chainIssue) {
      userParts.push(currentIssueBlock);
      userParts.push(`\nYou are working on issue ${chainIdx + 1} of ${chainQueue.length} in this run. Be efficient — complete the task, update status, and stop. Remaining turn budget: ${maxTurns - globalTurn}.`);
    } else {
      if (currentIssueBlock) userParts.push(currentIssueBlock);
      if (assignedIssuesBlock) userParts.push(assignedIssuesBlock);
      if (!currentIssueBlock && !assignedIssuesBlock && (wakeReason === "heartbeat_timer" || !wakeReason)) {
        userParts.push("\nThis is a routine heartbeat. You have no assigned tasks. Report status briefly and stop.");
      }
    }
    if (memoryBlock) userParts.push(memoryBlock);

    const messages: ChatMessage[] = [
      { role: "system", content: systemParts.join("\n") },
      { role: "user", content: userParts.join("\n\n") },
    ];

    await onLog("stdout", `[openrouter] Starting (model: ${model}, cwd: ${cwd})\n`);

    // ── Conversation loop (shared turn budget) ──────────────
    const turnsThisIteration = maxTurns - globalTurn;
    let iterationLastMessage = "";
    let iterationBroke = false;

    for (let localTurn = 0; localTurn < turnsThisIteration; localTurn++) {
      if (Date.now() - startedAt > timeoutSec * 1000) {
        chainTimedOut = true;
        iterationBroke = true;
        break;
      }

      const isLastTurn = globalTurn + 1 >= maxTurns;
      let result;
      try {
        result = await callOpenRouter(apiKey, model, messages, isLastTurn ? undefined : allTools, Math.max(30_000, (timeoutSec * 1000) - (Date.now() - startedAt)));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "API call failed";
        // Fallback: pick the right backup based on which model type was active
        const fb = model === heartbeatModel ? fallbackHeartbeatModel
          : model === complexModel ? fallbackComplexModel
          : fallbackModel;
        if (isQuotaOrRateLimitError(msg) && fb && fb !== model) {
          try {
            await onLog("stderr", `[openrouter] ${model} rate-limited, switching to ${fb}\n`);
            result = await callOpenRouter(apiKey, fb, messages, isLastTurn ? undefined : allTools, Math.max(30_000, (timeoutSec * 1000) - (Date.now() - startedAt)));
            model = fb; // use fallback for remaining turns
          } catch (fbErr: unknown) {
            const fbMsg = fbErr instanceof Error ? fbErr.message : "fallback failed";
            await onLog("stderr", `[openrouter] Fallback ${fb} also failed: ${fbMsg}\n`);
            chainErrorMessage = fbMsg;
            iterationBroke = true;
            break;
          }
        } else {
          await onLog("stderr", `[openrouter] ${msg}\n`);
          chainErrorMessage = msg;
          iterationBroke = true;
          break;
        }
      }

      if (!result) { iterationBroke = true; break; }
      globalTurn++;
      if (result.usage) { totalIn += result.usage.prompt_tokens || 0; totalOut += result.usage.completion_tokens || 0; }
      totalCost += result.cost;
      if (result.model) resolvedModel = result.model;

      messages.push(result.message);

      if (!result.message.tool_calls?.length) {
        iterationLastMessage = result.message.content || "";
        if (!iterationLastMessage.trim() && localTurn > 0) {
          iterationLastMessage = `[Auto-summary] Agent completed ${localTurn + 1} turns. No explicit summary provided.`;
        }
        await onLog("stdout", `[openrouter] Response:\n${iterationLastMessage.substring(0, 1000)}\n`);
        break;
      }

      // Warn agent when nearing the global turn limit
      if (globalTurn === maxTurns - 2) {
        messages.push({ role: "user", content: "SYSTEM: You have 2 tool calls remaining before this run ends. You MUST do these things NOW:\n1. Call update_issue to set the task status (done, in_progress, or blocked)\n2. Call add_comment with a summary of what you accomplished\nIf you have remaining work, set status to in_progress. If complete, set to done. Do NOT skip the status update." });
        await onLog("stdout", `[openrouter] Warning agent: nearing turn limit\n`);
      }

      for (const tc of result.message.tool_calls) {
        await onLog("stdout", `[openrouter] Tool: ${tc.function.name}\n`);
        let toolResult: string;

        // Check if this is a plugin tool (normalized name maps to a namespaced name)
        const pluginNamespaced = pluginToolNameMap.get(tc.function.name);
        if (pluginNamespaced) {
          let args: Record<string, unknown>;
          try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
          toolResult = await executePluginTool(
            pluginNamespaced,
            args,
            port,
            jwtAuthHeader,
            { agentId: agent.id, runId, companyId: agent.companyId, projectId: currentIssueProjectId || "" },
          );
        } else {
          toolResult = await executeToolCall(tc.function.name, tc.function.arguments, cwd, onLog, {
            port,
            authHeader: jwtAuthHeader,
            companyId: agent.companyId,
            agentId: agent.id,
            runId,
            agentName: agent.name,
            projectId: currentIssueProjectId,
            shellEnv: {
              PAPERCLIP_AGENT_ID: agent.id,
              PAPERCLIP_COMPANY_ID: agent.companyId,
              PAPERCLIP_API_URL: `http://localhost:${port}`,
              PAPERCLIP_RUN_ID: runId,
              PAPERCLIP_TASK_ID: currentIssueId || "",
              PAPERCLIP_WAKE_REASON: wakeReason || "",
              ...(jwtAuthHeader ? { PAPERCLIP_API_KEY: jwtAuthHeader.replace("Bearer ", "") } : {}),
            },
          });
        }
        messages.push({ role: "tool", content: sanitize(toolResult).substring(0, 50_000), tool_call_id: tc.id });
      }
    }

    lastMessage = iterationLastMessage || lastMessage;

    // ── Per-issue auto-advance ──────────────────────────────
    if (currentIssueId && jwtAuthHeader) {
      try {
        const port = process.env.PORT || "3100";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (jwtAuthHeader) headers["Authorization"] = jwtAuthHeader;
        headers["X-Paperclip-Run-Id"] = runId;
        const checkRes = await fetch(`http://localhost:${port}/api/issues/${currentIssueId}`, { headers, signal: AbortSignal.timeout(5000) });
        if (checkRes.ok) {
          const issue = await checkRes.json() as { status?: string; identifier?: string };
          if (issue.status === "todo" || issue.status === "in_progress") {
            let hasOpenSubtasks = false;
            if (issue.status === "in_progress") {
              try {
                const childRes = await fetch(`http://localhost:${port}/api/companies/${agent.companyId}/issues?parentId=${currentIssueId}`, { headers, signal: AbortSignal.timeout(5000) });
                if (childRes.ok) {
                  const children = await childRes.json() as Array<{ status?: string }>;
                  hasOpenSubtasks = children.some(c => c.status !== "done" && c.status !== "cancelled");
                }
              } catch { /* best effort */ }
            }
            await fetch(`http://localhost:${port}/api/issues/${currentIssueId}/checkout`, { method: "POST", headers, body: JSON.stringify({ agentId: agent.id, expectedStatuses: ["todo", "in_progress", "blocked"] }), signal: AbortSignal.timeout(5000) }).catch(() => {});
            const newStatus = issue.status === "todo" ? "in_progress" : (hasOpenSubtasks ? "in_progress" : "done");
            if (newStatus !== issue.status) {
              const body: Record<string, unknown> = { status: newStatus };
              if (newStatus === "done") body.comment = "[Auto-closed] Agent completed run without explicitly marking done.";
              const patchRes = await fetch(`http://localhost:${port}/api/issues/${currentIssueId}`, { method: "PATCH", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
              if (patchRes.ok) {
                await onLog("stdout", `[openrouter] Auto-${newStatus === "done" ? "closed" : "updated"} ${issue.identifier} → ${newStatus}\n`);
              }
            }
          }
        }
      } catch { /* best effort */ }
    }

    // ── Extract memories from run output ──────────────────────
    // Only store memories when the agent worked on an actual task (not idle heartbeats)
    if (currentIssueId && iterationLastMessage && iterationLastMessage.length > 100) {
      try {
        const memosUrl = process.env.MEMOS_URL || "http://memos:8000";
        // Register agent (idempotent)
        await fetch(`${memosUrl}/product/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: agent.id, user_name: agent.name || agent.id }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
        // Store the run output as memory
        const metaLine = [
          `[source: auto_extract]`,
          currentIssueProjectId ? `[project: ${currentIssueProjectId}]` : "",
          currentIssueId ? `[issue: ${currentIssueId}]` : "",
          `[run: ${runId}]`,
        ].filter(Boolean).join("\n");
        await fetch(`${memosUrl}/product/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: agent.id,
            writable_cube_ids: [agent.companyId],
            messages: [{ role: "assistant", content: `${iterationLastMessage.substring(0, 3000)}\n${metaLine}` }],
            async_mode: "async",
          }),
          signal: AbortSignal.timeout(5000),
        });
        await onLog("stdout", `[openrouter] Stored run memories\n`);
      } catch { /* best effort */ }
    }

    // Track chain progress
    if (chainIssue) {
      chainSummaries.push(`${chainIssue.identifier}: ${(iterationLastMessage || "completed").substring(0, 200)}`);
    }

    // Stop chain on error or timeout
    if (iterationBroke) break;
  }
  // ── End of chain loop ─────────────────────────────────────

  const summary = isChainedRun
    ? `Chained ${chainSummaries.length}/${chainQueue.length} issues:\n${chainSummaries.join("\n")}`
    : lastMessage || null;

  await onLog("stdout", `[openrouter] Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s | ${totalIn}+${totalOut} tokens | $${totalCost.toFixed(4)}\n`);

  return { exitCode: chainErrorMessage ? 1 : 0, signal: null, timedOut: chainTimedOut, errorMessage: chainErrorMessage, usage: { inputTokens: totalIn, outputTokens: totalOut }, provider: "openrouter", biller: "openrouter", model: resolvedModel, billingType: "api", costUsd: totalCost || null, summary };
}
