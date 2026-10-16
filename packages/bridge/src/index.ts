import crypto from "node:crypto";
import {
  SessionManager,
  VERSION as PI_VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_VERSION,
  SYSTEM_PROMPT_SECTION,
  TOOL_DEFS,
  TOOL_NAMES,
  deadlineFor,
  formatTabContext,
  type ContentBlock,
  type ConfigBody,
  type ModelsResponse,
  type PermissionMode,
  type PromptBody,
  type SessionSummary,
  type ToolProgress,
  type ToolRequest,
  type ToolResult,
} from "@pi-browser/shared";
import { resolveConfig, type ResolvedConfig } from "./config";
import { formatMatches, pickHelperModel, runFind } from "./find";
import { Logger } from "./logger";
import { BridgeServer, HttpError } from "./server";
import { TokenStore } from "./token-store";
import { checkUploadPaths } from "./upload-paths";

export interface SessionController {
  newSession?(): Promise<{ id: string }>;
}

export interface BridgeOptions {
  /** Provided by the headless host (API-02), which can replace sessions. */
  controller?: SessionController;
  tokenFile?: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function createBridgeExtension(options: BridgeOptions = {}): ExtensionFactory {
  return function piBrowserBridge(pi: ExtensionAPI) {
    pi.registerFlag("browser-port", { description: "Port of the pi-browser-bridge HTTP server (default 47823)", type: "string" });

    const tokens = new TokenStore(options.tokenFile);
    const log = new Logger(false);
    let cfg: ResolvedConfig = resolveConfig(undefined);
    let server: BridgeServer | null = null;
    let ctxRef: ExtensionContext | null = null;
    let toolsOff = false;
    let permissionMode: PermissionMode = "ask";
    let startError: string | null = null;
    const progress = new Map<string, (msg: string) => void>();

    const ctx = (): ExtensionContext => {
      if (!ctxRef) throw new HttpError(503, "pi session not ready");
      return ctxRef;
    };

    const currentModelId = () => (ctxRef?.model ? `${ctxRef.model.provider}/${ctxRef.model.id}` : null);

    // ---- tools -----------------------------------------------------------------------------------------------------
    for (const def of TOOL_DEFS) {
      pi.registerTool({
        name: def.name,
        label: def.label,
        description: def.description,
        parameters: def.parameters,
        annotations: def.annotations,
        promptSnippet: `${def.name}: ${def.description.split(". ")[0]}`,
        executionMode: "sequential",
        async execute(toolCallId, params: any, signal, onUpdate, c) {
          if (!server) throw new Error("Browser bridge is not running. Use /browser to check its status.");
          if (cfg.disabledTools.includes(def.name)) throw new Error(`The ${def.name} tool is disabled in the bridge configuration.`);
          const args = (params ?? {}) as Record<string, unknown>;
          const emitProgress = (message: string) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
          if (def.name === "find") return execFind(c, toolCallId, args, signal, emitProgress);
          if (def.name === "file_upload") {
            const chk = checkUploadPaths(((args.paths as string[]) ?? []).map(String), c.cwd, cfg.uploadRoots);
            if (!chk.ok) throw new Error(chk.error);
            args.paths = chk.paths;
          }
          const res = await callBrowser(def.name, toolCallId, args, signal, emitProgress);
          return toAgentResult(def.name, res);
        },
      });
    }

    function sessionId(): string {
      try {
        return ctxRef?.sessionManager.getSessionId() ?? "none";
      } catch {
        return "none";
      }
    }

    async function callBrowser(
      tool: string,
      toolCallId: string,
      args: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onProgress?: (m: string) => void,
    ): Promise<ToolResult> {
      if (!server) throw new Error("Browser bridge is not running");
      const req: ToolRequest = {
        requestId: `req_${crypto.randomBytes(8).toString("hex")}`,
        toolCallId,
        tool,
        args,
        sessionId: sessionId(),
        deadlineMs: deadlineFor(tool, args),
      };
      if (onProgress) progress.set(req.requestId, onProgress);
      try {
        log.debug("tool_request", { tool, args });
        const r = await server.requestTool(req, signal);
        log.debug("tool_result", { tool, ok: r.ok });
        return r;
      } finally {
        progress.delete(req.requestId);
      }
    }

    /** API-12: 1:1 content mapping; ok:false -> thrown error so pi marks the result failed. */
    function toAgentResult(tool: string, r: ToolResult) {
      if (!r.ok) {
        const text = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
        throw new Error(text || `${tool} failed`);
      }
      const content = r.content.map((c: ContentBlock) =>
        c.type === "text" ? { type: "text" as const, text: c.text } : { type: "image" as const, mimeType: c.mimeType, data: c.data },
      );
      if (!content.length) content.push({ type: "text" as const, text: "Done." });
      return { content, details: (r.details ?? undefined) as any, usage: r.usage as any };
    }

    async function execFind(
      c: ExtensionContext,
      toolCallId: string,
      args: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onProgress: (m: string) => void,
    ) {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      onProgress("Reading page outline…");
      const treeRes = await callBrowser("__get_tree", toolCallId, { tabId: args.tabId, filter: "all", depth: 30, max_chars: 120_000 }, signal);
      if (!treeRes.ok) throw new Error(treeRes.content.map((x) => (x.type === "text" ? x.text : "")).join("\n") || "Could not read the page");
      const tree = treeRes.content.map((x) => (x.type === "text" ? x.text : "")).join("\n");
      const url = String((treeRes.details as any)?.tabUrl ?? "");
      onProgress("Asking helper model…");
      const helper = pickHelperModel(c, cfg.helperModel);
      const { matches, usage } = await runFind(c, helper, query, tree, url, signal);
      let rects: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
      if (matches.length) {
        const rr = await callBrowser("__get_rects", toolCallId, { tabId: args.tabId, refs: matches.map((m) => m.ref) }, signal);
        if (rr.ok) rects = ((rr.details as any)?.rects ?? {}) as typeof rects;
      }
      return { content: formatMatches(matches, rects), details: { matches, helper: helper ? `${helper.provider}/${helper.id}` : null } as any, usage: usage as any };
    }

    // ---- prompt composition ------------------------------------------------------------------------------------------
    function toContent(body: PromptBody) {
      const parts: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
      let text = body.text ?? "";
      const tc = formatTabContext(body.tabContext ?? []);
      if (tc) text += `\n\n${tc}`;
      parts.push({ type: "text", text });
      for (const a of body.attachments ?? []) parts.push({ type: "image", data: a.data, mimeType: a.mimeType });
      return parts;
    }

    // ---- sessions --------------------------------------------------------------------------------------------------------
    async function listSessions(): Promise<SessionSummary[]> {
      const c = ctx();
      const infos = await SessionManager.list(c.cwd);
      return infos
        .map((i) => ({ id: i.id, name: i.name || i.firstMessage?.slice(0, 80) || i.id, updatedAt: i.modified.getTime() }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function sessionMessages(id: string): Promise<unknown[]> {
      const c = ctx();
      const file = SessionManager.findById(c.cwd, id);
      if (!file) throw new HttpError(404, "Unknown session");
      const sm = SessionManager.open(file);
      const out: unknown[] = [];
      for (const e of sm.getBranch()) {
        if (e.type !== "message") continue;
        const m: any = e.message;
        if (m.role === "user") out.push({ role: "user", text: contentText(m.content) });
        else if (m.role === "assistant") out.push({ role: "assistant", text: contentText(m.content), tools: (m.content ?? []).filter((x: any) => x.type === "toolCall").map((x: any) => ({ id: x.id, name: x.name, args: x.arguments })) });
        else if (m.role === "toolResult") out.push({ role: "tool", toolCallId: m.toolCallId, toolName: m.toolName, text: contentText(m.content), isError: !!m.isError });
      }
      return out;
    }

    function contentText(content: unknown): string {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
    }

    async function models(): Promise<ModelsResponse> {
      const c = ctx();
      const list = c.modelRegistry.getAvailable().map((m) => ({
        id: `${m.provider}/${m.id}`,
        provider: String(m.provider),
        name: (m as any).name ?? m.id,
        reasoning: !!m.reasoning,
      }));
      return { models: list, thinkingLevels: THINKING_LEVELS, current: { model: currentModelId(), thinkingLevel: pi.getThinkingLevel() } };
    }

    async function setConfig(body: ConfigBody) {
      const c = ctx();
      if (body.model) {
        const [prov, ...rest] = body.model.split("/");
        const m = c.modelRegistry.find(prov, rest.join("/"));
        if (!m) throw new HttpError(400, `Unknown model ${body.model}`);
        const ok = await pi.setModel(m);
        if (!ok) throw new HttpError(400, `No credentials configured for ${prov}`);
      }
      if (body.thinkingLevel) {
        if (!THINKING_LEVELS.includes(body.thinkingLevel)) throw new HttpError(400, "Unknown thinking level");
        pi.setThinkingLevel(body.thinkingLevel as any);
      }
      if (body.permissionMode) permissionMode = body.permissionMode;
    }

    // ---- lifecycle ---------------------------------------------------------------------------------------------------------
    async function startServer(c: ExtensionContext) {
      if (server) return;
      cfg = resolveConfig(pi.getFlag("browser-port"));
      log.setEnabled(cfg.debug);
      const s = new BridgeServer({
        port: cfg.port,
        extensionId: cfg.extensionId,
        tokens,
        log,
        handlers: {
          health: () => ({ bridgeVersion: BRIDGE_VERSION, piVersion: PI_VERSION, model: currentModelId(), sessionId: sessionId() }),
          async prompt(body) {
            if (!body?.text && !body?.attachments?.length) throw new HttpError(400, "text required");
            server?.emit({ type: "user_message", text: body.text ?? "", source: "panel" });
            const idle = ctx().isIdle();
            pi.sendUserMessage(toContent(body), idle ? undefined : { deliverAs: "followUp" });
          },
          async steer(body) {
            server?.emit({ type: "user_message", text: body.text ?? "", source: "panel" });
            pi.sendUserMessage(toContent(body), { deliverAs: "steer" });
          },
          async abort() {
            ctx().abort();
          },
          listSessions,
          async newSession() {
            if (!options.controller?.newSession) {
              throw new HttpError(409, "In terminal mode, start a new session in pi with /new (or run /browser new). The panel follows automatically.");
            }
            return options.controller.newSession();
          },
          sessionMessages,
          models,
          setConfig,
          toolProgress(p: ToolProgress) {
            progress.get(p.requestId)?.(p.message);
          },
          onClientConnected() {
            log.debug("client connected");
          },
        },
      });
      try {
        await s.start();
        server = s;
        startError = null;
      } catch (e: any) {
        startError = e?.code === "EADDRINUSE" ? `Port ${cfg.port} is in use (another pi instance?). Use --browser-port.` : String(e?.message ?? e);
        c.ui.notify(`pi-browser-bridge: ${startError}`, "error");
      }
    }

    pi.on("session_start", async (_e, c) => {
      ctxRef = c;
      await startServer(c);
      applyToolState();
      server?.emit({ type: "hello", sessionId: sessionId(), model: currentModelId(), bridgeVersion: BRIDGE_VERSION });
      if (c.hasUI) c.ui.setStatus?.("browser", server ? `browser :${server.port}${tokens.paired ? "" : " (not paired)"}` : "browser off");
    });

    pi.on("session_shutdown", async () => {
      const s = server;
      server = null;
      ctxRef = null;
      log.close();
      if (s) await s.stop();
    });

    function applyToolState() {
      const active = new Set(pi.getActiveTools());
      for (const n of TOOL_NAMES) {
        if (toolsOff || cfg.disabledTools.includes(n)) active.delete(n);
        else active.add(n);
      }
      pi.setActiveTools([...active]);
    }

    // ---- events -> SSE ----------------------------------------------------------------------------------------------------------
    pi.on("before_agent_start", async (e) => {
      if (toolsOff) return;
      e.systemPromptOptions.sections = { ...e.systemPromptOptions.sections, browser_work: SYSTEM_PROMPT_SECTION };
    });
    pi.on("input", async (e, c) => {
      ctxRef = c;
      if (e.source === "interactive") server?.emit({ type: "user_message", text: e.text, source: "terminal" });
      return { action: "continue" };
    });
    pi.on("agent_start", async (_e, c) => {
      ctxRef = c;
      server?.emit({ type: "run_state", state: "started" });
    });
    pi.on("agent_end", async () => void server?.emit({ type: "run_state", state: "ended" }));
    pi.on("agent_settled", async (e) => void server?.emit({ type: "run_state", state: "settled", aborted: e.aborted }));
    pi.on("message_update", async (e) => {
      const ev = e.assistantMessageEvent;
      if (ev.type === "text_delta") server?.emit({ type: "assistant_delta", text: ev.delta });
    });
    pi.on("message_end", async (e) => {
      const m: any = e.message;
      if (m?.role !== "assistant") return;
      const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      const thinking = (m.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking ?? c.text ?? "").join("");
      server?.emit({ type: "assistant_message", text, thinking: thinking || undefined });
      if (m.stopReason === "error" && m.errorMessage) server?.emit({ type: "error", message: String(m.errorMessage) });
    });
    pi.on("tool_execution_start", async (e) => {
      server?.emit({ type: "tool_activity", phase: "start", toolCallId: e.toolCallId, toolName: e.toolName, summary: summarize(e.toolName, e.args) });
    });
    pi.on("tool_execution_end", async (e) => {
      server?.emit({ type: "tool_activity", phase: "end", toolCallId: e.toolCallId, toolName: e.toolName, summary: "", isError: e.isError });
    });

    // ---- /browser command ---------------------------------------------------------------------------------------------------------
    pi.registerCommand("browser", {
      description: "Browser bridge: status | pair | revoke [id] | tools on|off | new",
      async handler(args, c) {
        const [sub, arg] = args.trim().split(/\s+/);
        switch (sub || "status") {
          case "pair": {
            const { code, expiresAt } = tokens.createPairingCode();
            c.ui.notify(`Pairing code: ${code}  (valid until ${new Date(expiresAt).toLocaleTimeString()}). Enter it in the extension's side panel.`, "info");
            return;
          }
          case "revoke": {
            const n = tokens.revoke(arg);
            c.ui.notify(n ? `Revoked ${n} paired browser(s).` : "No matching paired browser.", "info");
            return;
          }
          case "tools": {
            if (arg !== "on" && arg !== "off") return void c.ui.notify("Usage: /browser tools on|off", "warning");
            toolsOff = arg === "off";
            applyToolState();
            c.ui.notify(`Browser tools ${toolsOff ? "disabled" : "enabled"}.`, "info");
            return;
          }
          case "new": {
            await c.newSession();
            return;
          }
          default: {
            const code = tokens.activeCode();
            const devices = tokens.listDevices();
            const lines = [
              server ? `Bridge listening on http://127.0.0.1:${server.port}` : `Bridge not running${startError ? `: ${startError}` : ""}`,
              `Browser stream: ${server?.connected ? "connected" : "not connected"}`,
              `Paired browsers: ${devices.length ? devices.map((d) => `${d.label} (${d.id})`).join(", ") : "none"}`,
              `Tools: ${toolsOff ? "off" : "on"}  Mode: ${permissionMode}`,
              code ? `Pairing code: ${code.code}` : "No pairing code active. Run /browser pair.",
            ];
            c.ui.notify(lines.join("\n"), "info");
          }
        }
      },
    });

  };
}

function summarize(tool: string, args: any): string {
  try {
    if (tool === "bash") return String(args?.command ?? "").slice(0, 200);
    if (tool === "read" || tool === "write" || tool === "edit") return String(args?.path ?? args?.file_path ?? "");
    if (tool === "computer") return `${args?.action ?? ""}${args?.ref ? ` ${args.ref}` : args?.coordinate ? ` (${args.coordinate.join(", ")})` : ""}${args?.text ? ` "${String(args.text).slice(0, 60)}"` : ""}`;
    if (tool === "navigate") return String(args?.url ?? "");
    const s = JSON.stringify(args ?? {});
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return "";
  }
}

export default createBridgeExtension();
