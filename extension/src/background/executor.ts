/** Executes tool requests from the bridge: tab checks, permissions, safety checks, dispatch, audit (architecture step 4). */
import {
  BATCHABLE_TOOLS,
  TOOL_BY_NAME,
  isMutatingAction,
  type ContentBlock,
  type ToolProgress,
  type ToolRequest,
  type ToolResult,
} from "@pi-browser/shared";
import { isHttpUrl, isRestrictedPage, normalizeUrl, registrableDomain } from "../common/domain";
import { getSettings, getShortcuts } from "../common/storage";
import type { ToolLogEntry } from "../common/messages";
import { audit } from "./audit";
import { attach, tabState } from "./cdp";
import { computer } from "./computer";
import { image, text, ToolError, type AuthExtras, type Out, type ToolEnv } from "./env";
import { readConsole, readNetwork, uploadImage, fileUpload, resizeWindow } from "./aux-tools";
import { formInput, getPageText, getRects, readPage, runJavaScript } from "./page-tools";
import type { PermissionManager } from "./permissions";
import { preCheck, SafetyError } from "./security";
import { addTabToGroup, assertInGroup, groupOfTab, sessionForGroup, tabContext, takeChangeNote, type GroupSession } from "./tab-groups";
import type { GifRecorder } from "./gif";
import { sendIndicator } from "./indicators";
import { getShot } from "../common/idb";

export interface ExecutorDeps {
  perms: PermissionManager;
  sendProgress(p: ToolProgress): void;
  onLog(e: ToolLogEntry): void;
  /** Group of the panel that most recently sent a prompt. */
  activeGroupId(): number | undefined;
  piSessionId(): string;
  gif: GifRecorder;
  runShortcut(id: string): Promise<string>;
  /** Bridge-side helpers for batch/auto mode. */
  bridgeFind(query: string, tree: string, url: string): Promise<{ matches: { ref: string; role?: string; name?: string; why?: string }[] }>;
  bridgeReview(r: { task: string; action: string; tool: string; domain: string; screenshot?: string }): Promise<{ allow: boolean; reason?: string }>;
  lastUserPrompt(): string;
  ensureIndicators(tabId: number): Promise<void>;
}

const cancels = new Map<string, AbortController>();

export function cancelRequest(requestId: string) {
  cancels.get(requestId)?.abort();
}

export function cancelAll() {
  for (const c of cancels.values()) c.abort();
}

const summaryOf = (tool: string, a: Record<string, any>): string => {
  if (tool === "computer") return `${a.action ?? ""}${a.ref ? ` ${a.ref}` : a.coordinate ? ` (${a.coordinate.map?.(Math.round).join(", ")})` : ""}${a.text ? ` "${String(a.text).slice(0, 40)}"` : ""}`;
  if (tool === "navigate") return String(a.url ?? "");
  if (tool === "javascript_tool") return String(a.text ?? "").slice(0, 80);
  if (tool === "browser_batch") return `${a.actions?.length ?? 0} actions`;
  if (tool === "find") return String(a.query ?? "");
  if (tool === "form_input") return `${a.ref ?? ""}`;
  return Object.keys(a).length ? JSON.stringify(a).slice(0, 80) : "";
};

export class ToolExecutor {
  constructor(private deps: ExecutorDeps) {}

  async execute(req: ToolRequest): Promise<ToolResult> {
    const ac = new AbortController();
    cancels.set(req.requestId, ac);
    const entry: ToolLogEntry = { toolCallId: req.toolCallId, tool: req.tool, summary: summaryOf(req.tool, req.args), done: false, progress: [] };
    this.deps.onLog({ ...entry });
    const shots: string[] = [];
    try {
      const settings = await getSettings();
      const out = await this.run(req, ac.signal, settings, shots, entry);
      const group = out.group;
      const content: ContentBlock[] = [...out.content];
      if (group) {
        const note = await takeChangeNote(group.groupId).catch(() => null);
        if (note) content.push(text(note)); // UI-08
      }
      const textOut = content.filter((c) => c.type === "text").map((c) => (c as any).text).join("\n");
      this.deps.onLog({ ...entry, ok: true, text: textOut.slice(0, 600), screenshotIds: shots, done: true });
      return { requestId: req.requestId, ok: true, content, details: out.details };
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.onLog({ ...entry, ok: false, text: msg.slice(0, 600), screenshotIds: shots, done: true });
      return { requestId: req.requestId, ok: false, content: [text(msg)] }; // NFA-06: never a hanging request
    } finally {
      cancels.delete(req.requestId);
      this.deps.perms.endToolCall(req.toolCallId);
    }
  }

  private async resolveGroup(args: Record<string, unknown>): Promise<GroupSession> {
    const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
    if (tabId !== undefined) {
      const g = await groupOfTab(tabId);
      if (!g) throw new ToolError(`Tab ${tabId} is not part of an agent tab group. Call tabs_context to list the tabs you may use.`);
      return g;
    }
    const gid = this.deps.activeGroupId();
    const g = gid !== undefined ? await sessionForGroup(gid) : undefined;
    if (!g) throw new ToolError("No browser session is open. Ask the user to click the extension icon on a tab to start a session.");
    return g;
  }

  private async run(req: ToolRequest, signal: AbortSignal, settings: Awaited<ReturnType<typeof getSettings>>, shots: string[], entry: ToolLogEntry) {
    const group = await this.resolveGroup(req.args);
    const env = this.makeEnv(req, req.toolCallId, signal, group, settings, shots, entry, false);
    const out = await this.dispatch(env, req.tool, req.args);
    return { ...out, group };
  }

  private makeEnv(req: ToolRequest, toolCallId: string, signal: AbortSignal, group: GroupSession, settings: Awaited<ReturnType<typeof getSettings>>, shots: string[], entry: ToolLogEntry, inBatch: boolean): ToolEnv {
    const deps = this.deps;
    const env: ToolEnv = {
      req,
      toolCallId,
      signal,
      group,
      perms: deps.perms,
      settings,
      sessionId: deps.piSessionId(),
      shots,
      inBatch,
      progress: (message, index, total) => {
        deps.sendProgress({ requestId: req.requestId, message, index, total });
        entry.progress = [...(entry.progress ?? []), { message, index, total }];
        deps.onLog({ ...entry });
      },
      authorize: async (x: AuthExtras) => {
        const tool = x.tool ?? req.tool;
        const args = x.args ?? req.args;
        const r = await deps.perms.authorize({
          groupId: group.groupId,
          mainTabId: group.mainTabId,
          toolCallId,
          tool,
          args,
          url: x.tabUrl,
          targetUrl: x.targetUrl,
          linkTargetUrl: x.linkTargetUrl,
          sensitive: x.sensitive,
          preview: x.preview,
          signal,
        });
        await audit({ sessionId: deps.piSessionId(), tool, action: String((args as any).action ?? tool), domain: r.domain, decision: r.decision, result: r.allowed ? "ok" : "denied", note: r.allowed ? undefined : r.reason });
        if (!r.allowed) throw new ToolError(r.reason ?? "Not permitted");
        // SEC-09: in automatic mode every consequential action gets a second look.
        if (r.decision === "auto" && (await deps.perms.mode()) === "auto" && isMutatingAction(tool, args as any)) {
          await this.autoReview(env, tool, x, r.domain);
        }
      },
      guard: async (tabId, what) => {
        try {
          await preCheck(tabId, group.groupId, deps.perms, what);
        } catch (e) {
          if (e instanceof SafetyError) throw new ToolError(e.message);
          throw e;
        }
      },
    };
    return env;
  }

  private async autoReview(env: ToolEnv, tool: string, x: AuthExtras, domain: string) {
    let screenshot: string | undefined;
    try {
      const ids = Array.from(new Set(env.shots)).slice(-1);
      if (ids[0]) screenshot = (await getShot(ids[0]))?.data ?? undefined;
    } catch {
      /* optional */
    }
    let verdict: { allow: boolean; reason?: string };
    try {
      verdict = await this.deps.bridgeReview({ task: this.deps.lastUserPrompt(), action: x.preview, tool, domain, screenshot });
    } catch {
      return; // review unavailable: fall back to the user's chosen automatic mode
    }
    if (verdict.allow) return;
    const ans = await this.deps.perms.ui.ask(
      { id: crypto.randomUUID(), type: "PLAN_APPROVAL", domain, tool, action: "Deviation from your task", preview: `${x.preview}\n\nThe safety check says: ${verdict.reason ?? "this does not look like part of your request"}.`, onceOnly: true, toolCallId: env.toolCallId },
      { groupId: env.group.groupId, mainTabId: env.group.mainTabId },
      env.signal,
    );
    if (ans === "deny") throw new ToolError(`Blocked by the automatic-mode safety check: ${verdict.reason ?? "the action does not match the task"}. The user declined it.`);
  }

  /** Runs one tool (also used for the sub-actions of browser_batch). */
  async dispatch(env: ToolEnv, name: string, a: Record<string, any>): Promise<Out> {
    const def = TOOL_BY_NAME.get(name);
    const internal = name === "__get_tree" || name === "__get_rects";
    if (!def && !internal) throw new ToolError(`Unknown tool ${name}`);
    if (env.signal.aborted) throw new ToolError("Cancelled");
    if (name === "javascript_tool" && !env.settings.jsToolEnabled) {
      throw new ToolError("The JavaScript tool is disabled by configuration or policy. Use read_page, get_page_text, find, form_input and computer instead.");
    }

    // Tools without a tab
    switch (name) {
      case "tabs_context":
        return this.tabsContext(env);
      case "tabs_create":
        return this.tabsCreate(env, a);
      case "update_plan":
        return this.updatePlan(env, a);
      case "shortcuts_list": {
        const list = await getShortcuts();
        return { content: [text(list.length ? list.map((s) => `${s.id}: ${s.name}${s.params?.length ? ` (params: ${s.params.join(", ")})` : ""}`).join("\n") : "No shortcuts saved.")] };
      }
      case "shortcuts_execute":
        return { content: [text(await this.deps.runShortcut(String(a.shortcutId)))] };
    }

    // Tab-scoped tools
    if (typeof a.tabId !== "number") {
      throw new ToolError("tabId is required. Call tabs_context to list the tabs of this session's tab group.");
    }
    const tabId = a.tabId as number;
    const tab = await assertInGroup(tabId, env.group.groupId); // UI-07 / SEC-07
    // TOOL-09
    if (name !== "navigate" && isRestrictedPage(tab.url || tab.pendingUrl)) {
      throw new ToolError(`This is a browser-internal or store page (${tab.url || tab.pendingUrl}) where only navigate is available. Navigate to a regular web page first.`);
    }
    void this.deps.ensureIndicators(tabId); // never wait for the page here: it may be blocked by a dialog
    if (tab.url) tabState(tabId); // make sure state exists

    switch (name) {
      case "navigate":
        return this.navigate(env, tab, a);
      case "computer":
        return this.runWithGif(env, tabId, a, () => computer(env, tabId, a as any));
      case "read_page": {
        await env.authorize({ tabUrl: tab.url ?? "", preview: `Read the page structure${a.ref_id ? ` below ${a.ref_id}` : ""}` });
        return readPage(env, tabId, a);
      }
      case "__get_tree": {
        await env.authorize({ tool: "find", args: { query: "tree" }, tabUrl: tab.url ?? "", preview: "Read the page structure for a search" });
        return readPage(env, tabId, { filter: "all", depth: a.depth ?? 30, max_chars: a.max_chars ?? 120_000 });
      }
      case "__get_rects":
        return getRects(tabId, (a.refs as string[]) ?? []);
      case "find":
        return this.findViaBridge(env, tab, a);
      case "get_page_text": {
        await env.authorize({ tabUrl: tab.url ?? "", preview: "Read the page text" });
        return getPageText(env, tabId, a);
      }
      case "form_input": {
        return formInput(env, tabId, a as any, async (sensitive) => {
          await env.authorize({ tool: "form_input", args: { ref: a.ref }, tabUrl: tab.url ?? "", sensitive, preview: sensitive ? `Fill ${a.ref} (password / card field, value hidden)` : `Fill ${a.ref} with: ${String(a.value).slice(0, 200)}` });
        });
      }
      case "javascript_tool": {
        if (a.action !== "javascript_exec") throw new ToolError('action must be "javascript_exec"');
        if (!String(a.text ?? "").trim()) throw new ToolError("text (the code) must not be empty");
        if (!isHttpUrl(tab.url)) throw new ToolError("JavaScript can only run on http(s) pages.");
        await env.authorize({ tabUrl: tab.url ?? "", preview: String(a.text).slice(0, 1500) });
        await env.guard(tabId, "running JavaScript");
        return runJavaScript(env, tabId, String(a.text));
      }
      case "tabs_close":
        return this.tabsClose(env, tabId);
      case "read_console_messages": {
        await env.authorize({ tabUrl: tab.url ?? "", preview: "Read the browser console" });
        return readConsole(env, tabId, a);
      }
      case "read_network_requests": {
        await env.authorize({ tabUrl: tab.url ?? "", preview: "Read network requests" });
        return readNetwork(env, tabId, a);
      }
      case "upload_image":
        return uploadImage(env, tabId, a as any);
      case "file_upload":
        return fileUpload(env, tabId, a as any);
      case "resize_window":
        return resizeWindow(env, tabId, a as any);
      case "gif_creator":
        return this.deps.gif.handle(env, tabId, a as any);
      case "browser_batch":
        return this.batch(env, tabId, a as any);
    }
    throw new ToolError(`Tool ${name} is not implemented`);
  }

  /** GIF recording hook (AUX-11): a frame after every action while recording. */
  private async runWithGif(env: ToolEnv, tabId: number, a: Record<string, any>, fn: () => Promise<Out>): Promise<Out> {
    const out = await fn();
    if (this.deps.gif.recording(env.group.groupId) && a.action !== "screenshot" && a.action !== "zoom" && a.action !== "wait") {
      await this.deps.gif.frame(env, tabId, a).catch(() => {});
    }
    return out;
  }

  // ---- tabs --------------------------------------------------------------------------------------------------------
  private async tabsContext(env: ToolEnv): Promise<Out> {
    const ctx = await tabContext(env.group.groupId);
    const lines = ctx.map((t) => `- tabId ${t.id}${t.id === env.group.mainTabId ? " (main)" : ""}: "${t.title.slice(0, 100)}" ${t.url}`);
    return { content: [text(`Tabs in this session's group:\n${lines.join("\n")}`)], details: { tabs: ctx } };
  }

  private async tabsCreate(env: ToolEnv, a: Record<string, any>): Promise<Out> {
    let url: string | undefined;
    if (a.url) {
      url = normalizeUrl(String(a.url));
      if (!isHttpUrl(url) && url !== "about:blank") throw new ToolError("Only http(s) URLs can be opened.");
      await env.authorize({ tool: "tabs_create", args: { url }, tabUrl: "", targetUrl: url, preview: `Open a new tab: ${url}` });
    }
    const tab = await chrome.tabs.create({ url: url ?? "about:blank", windowId: env.group.windowId, active: false });
    if (!tab.id) throw new ToolError("Could not create the tab");
    await addTabToGroup(tab.id, env.group.groupId);
    if (url) await waitForLoad(tab.id, 30_000);
    return { content: [text(`Created tab ${tab.id}${url ? ` at ${url}` : ""}.`)], details: { tabId: tab.id } };
  }

  private async tabsClose(env: ToolEnv, tabId: number): Promise<Out> {
    if (tabId === env.group.mainTabId) throw new ToolError("The main tab cannot be closed by the agent.");
    await chrome.tabs.remove(tabId);
    return { content: [text(`Closed tab ${tabId}.`)] };
  }

  private async updatePlan(env: ToolEnv, a: Record<string, any>): Promise<Out> {
    const domains = ((a.domains as string[]) ?? []).map(String);
    const approach = ((a.approach as string[]) ?? []).map(String);
    if (approach.length < 3 || approach.length > 7) throw new ToolError("approach needs 3 to 7 points");
    await env.authorize({ tool: "update_plan", args: { domains, approach }, tabUrl: "", preview: approach.map((p, i) => `${i + 1}. ${p}`).join("\n") });
    env.perms.setPlan(env.group.groupId, domains);
    return { content: [text(`Plan approved by the user. You may now work on: ${domains.join(", ") || "(no domains listed)"}.`)] };
  }

  // ---- navigation ---------------------------------------------------------------------------------------------------
  private async navigate(env: ToolEnv, tab: chrome.tabs.Tab, a: Record<string, any>): Promise<Out> {
    const tabId = tab.id!;
    const raw = String(a.url ?? "").trim();
    if (!raw) throw new ToolError("url is required");
    await attach(tabId).catch(() => {}); // for the leave-page dialog handling; navigation works without it
    tabState(tabId).acceptBeforeUnload = a.leaveDialog === "accept";
    if (raw === "back" || raw === "forward") {
      await env.authorize({ tool: "navigate", args: { url: raw }, tabUrl: tab.url ?? "", preview: `Go ${raw}` });
      const done = waitForLoad(tabId, 30_000);
      try {
        await (raw === "back" ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
      } catch (e: any) {
        throw new ToolError(`Cannot go ${raw}: ${String(e?.message ?? e)}`);
      }
      await done;
    } else {
      const url = normalizeUrl(raw);
      if (!isHttpUrl(url) && url !== "about:blank") throw new ToolError("Only http(s) URLs can be opened (javascript:, data:, file: and browser-internal URLs are not allowed).");
      await env.authorize({ tool: "navigate", args: { url }, tabUrl: tab.url ?? "", targetUrl: url, preview: `Navigate to ${url}` });
      const done = waitForLoad(tabId, 30_000);
      await chrome.tabs.update(tabId, { url });
      const r = await done;
      if (r.error) throw new ToolError(`Navigation failed: ${r.error}`);
      if (r.cancelled) throw new ToolError(`The page asked "leave this page?" and the dialog was cancelled, so the tab stayed on ${(await chrome.tabs.get(tabId)).url}. Retry with leaveDialog "accept" to leave anyway.`);
    }
    const t = await chrome.tabs.get(tabId);
    const notes = tabState(tabId).dialogNotes.filter((n) => !n.startsWith("prompt:"));
    tabState(tabId).dialogNotes = tabState(tabId).dialogNotes.filter((n) => n.startsWith("prompt:"));
    return { content: [text([`Navigated to ${t.url} ("${(t.title ?? "").slice(0, 100)}")`, ...notes].join(". "))], details: { tabUrl: t.url ?? "" } };
  }

  // ---- find in batch -----------------------------------------------------------------------------------------------
  private async findViaBridge(env: ToolEnv, tab: chrome.tabs.Tab, a: Record<string, any>): Promise<Out> {
    // find is normally executed in the bridge (API-16). Inside browser_batch the extension asks the bridge for the helper-model step.
    await env.authorize({ tool: "find", args: { query: a.query }, tabUrl: tab.url ?? "", preview: `Search the page: ${a.query}` });
    const tree = await readPage(env, tab.id!, { filter: "all", depth: 30, max_chars: 120_000 });
    const treeText = String((tree.details as any)?.tree ?? "");
    const { matches } = await this.deps.bridgeFind(String(a.query), treeText, tab.url ?? "");
    const rr = matches.length ? await getRects(tab.id!, matches.map((m) => m.ref)) : null;
    const rects = ((rr?.details as any)?.rects ?? {}) as Record<string, { x: number; y: number; w: number; h: number } | null>;
    if (!matches.length) return { content: [text("No matching elements found.")] };
    return {
      content: [
        text(
          matches
            .map((m, i) => {
              const r = rects[m.ref];
              return `${i + 1}. ${m.ref} ${m.role ?? ""} "${m.name ?? ""}"${r ? ` at (${Math.round(r.x + r.w / 2)}, ${Math.round(r.y + r.h / 2)})` : " (not in view)"}${m.why ? ` - ${m.why}` : ""}`;
            })
            .join("\n"),
        ),
      ],
    };
  }

  // ---- browser_batch -----------------------------------------------------------------------------------------------
  private async batch(env: ToolEnv, tabId: number, a: { actions: { name: string; input: Record<string, any> }[] }): Promise<Out> {
    const actions = a.actions ?? [];
    if (!actions.length) throw new ToolError("actions must not be empty");
    const allowed = new Set<string>(BATCHABLE_TOOLS);
    const content: ContentBlock[] = [];
    let done = 0;
    let failure: string | null = null;
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      env.progress(`${i + 1}/${actions.length}: ${act.name}`, i + 1, actions.length); // TOOL-07
      if (!allowed.has(act.name)) {
        failure = `Action ${i + 1} (${act.name}) is not allowed in a batch. Allowed: ${[...allowed].join(", ")}.`;
        break;
      }
      if (env.signal.aborted) {
        failure = "Cancelled";
        break;
      }
      try {
        const input = { tabId, ...(act.input ?? {}) };
        const sub: ToolEnv = { ...env, inBatch: true };
        const out = await this.dispatch(sub, act.name, input);
        content.push(...out.content);
        done++;
      } catch (e: any) {
        failure = `Action ${i + 1} (${act.name}) failed: ${e instanceof Error ? e.message : String(e)}`; // TOOL-05
        break;
      }
    }
    const summary = failure
      ? `${failure}\nExecuted ${done} of ${actions.length} actions; skipped ${actions.length - done - 1}.`
      : `Executed all ${done} actions.`;
    if (failure) {
      // The batch aborts: report as failure but keep what was collected.
      throw new ToolError([summary, ...content.filter((c) => c.type === "text").map((c) => (c as any).text)].join("\n"));
    }
    return { content: [text(summary), ...content] };
  }
}

/** Waits for the main frame of a tab to finish navigating (or fail), at most `ms`. */
export function waitForLoad(tabId: number, ms: number): Promise<{ error?: string; cancelled?: boolean }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const poll = setInterval(() => {
      // a cancelled "leave page?" dialog means the navigation will never complete
      if (tabState(tabId).leaveCancelledAt >= startedAt) done({ cancelled: true });
    }, 100);
    const done = (r: { error?: string; cancelled?: boolean }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.webNavigation.onCompleted.removeListener(onOk);
      chrome.webNavigation.onErrorOccurred.removeListener(onErr);
      resolve(r);
    };
    const onOk = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (d.tabId === tabId && d.frameId === 0) done({});
    };
    const onErr = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (d.tabId === tabId && d.frameId === 0 && d.error !== "net::ERR_ABORTED") done({ error: d.error });
    };
    chrome.webNavigation.onCompleted.addListener(onOk);
    chrome.webNavigation.onErrorOccurred.addListener(onErr);
    const timer = setTimeout(() => done({}), ms);
  });
}
