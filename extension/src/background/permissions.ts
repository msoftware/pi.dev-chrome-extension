/** Central permission manager (requirements section 11). */
import {
  categorizeDomain,
  decide,
  requiredPermission,
  type ApprovalRecord,
  type DomainCategory,
  type PermissionPolicy,
  type PermissionType,
} from "@pi-browser/shared/permissions";
import type { PermissionMode } from "@pi-browser/shared/protocol";
import { registrableDomain } from "../common/domain";
import { getSettings } from "../common/storage";
import type { ApprovalRequest } from "../common/messages";

export type Decision = "once" | "always" | "deny";

export interface AskUi {
  ask(req: ApprovalRequest, ctx: { groupId: number; mainTabId: number }, signal?: AbortSignal): Promise<Decision>;
}

export interface AuthInput {
  groupId: number;
  mainTabId: number;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Current URL of the target tab. */
  url: string;
  /** For navigations: where the tab is going. */
  targetUrl?: string;
  /** The action types into a password or card field (SEC-10). */
  sensitive?: boolean;
  /** Link click that would leave the current domain (SEC-05). */
  linkTargetUrl?: string;
  preview: string;
  signal?: AbortSignal;
}

export interface AuthResult {
  allowed: boolean;
  reason?: string;
  domain: string;
  decision: string;
  category: DomainCategory;
}

interface PolicyCache {
  at: number;
  mode: PermissionMode;
  policy: PermissionPolicy;
}

const CACHE_MS = 5 * 60_000;

export class PermissionManager {
  private onceGrants = new Set<string>();
  private cache: PolicyCache | null = null;
  private planDomains = new Map<number, Set<string>>(); // groupId -> domains
  private alwaysGrants: ApprovalRecord[] | null = null;

  constructor(public readonly ui: AskUi) {}

  /** Settings or grants changed in storage (e.g. from the options page). */
  invalidate() {
    this.cache = null;
    this.alwaysGrants = null;
  }

  private async policy(): Promise<PolicyCache> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache;
    const s = await getSettings();
    const norm = (l: string[]) => l.map((d) => registrableDomain(d) || d.toLowerCase());
    this.cache = {
      at: now,
      mode: s.permissionMode,
      policy: {
        blockedDomains: norm(s.blockedDomains),
        alwaysAskDomains: norm(s.alwaysAskDomains),
        allowedDomains: norm(s.allowedDomains),
        policyBlocked: norm(s.policy.blockedDomains ?? []),
        policyAlwaysAsk: norm(s.policy.alwaysAskDomains ?? []),
        policyAllowed: norm(s.policy.allowedDomains ?? []),
      },
    };
    return this.cache;
  }

  async mode(): Promise<PermissionMode> {
    return (await this.policy()).mode;
  }

  /** SEC-06 */
  async categoryOf(url: string): Promise<{ domain: string; category: DomainCategory }> {
    const domain = registrableDomain(url);
    if (!domain) return { domain: "", category: "default" };
    return { domain, category: categorizeDomain(domain, (await this.policy()).policy) };
  }

  private async always(): Promise<ApprovalRecord[]> {
    if (!this.alwaysGrants) this.alwaysGrants = ((await chrome.storage.local.get("grants")).grants as ApprovalRecord[] | undefined) ?? [];
    return this.alwaysGrants;
  }

  async listGrants(): Promise<ApprovalRecord[]> {
    return [...(await this.always())];
  }
  async revokeGrant(domain: string, type: PermissionType | "*") {
    const g = (await this.always()).filter((x) => !(x.domain === domain && (type === "*" || x.type === type)));
    this.alwaysGrants = g;
    await chrome.storage.local.set({ grants: g });
  }
  async revokeAll() {
    this.alwaysGrants = [];
    await chrome.storage.local.set({ grants: [] });
    this.onceGrants.clear();
  }

  setPlan(groupId: number, domains: string[]) {
    this.planDomains.set(groupId, new Set(domains.map((d) => registrableDomain(d) || d.toLowerCase())));
  }
  planFor(groupId: number): string[] {
    return [...(this.planDomains.get(groupId) ?? [])];
  }

  /** Whether the domain counts as approved for this session (used by the SEC-08 pre-check and SEC-05). */
  async isApproved(domain: string, groupId: number): Promise<boolean> {
    if (!domain) return false;
    const p = await this.policy();
    const cat = categorizeDomain(domain, p.policy);
    if (cat === "blocked") return false;
    if (cat === "allowed") return true;
    if (p.mode === "auto" && cat !== "always_ask") return true;
    if (p.mode === "plan" && this.planDomains.get(groupId)?.has(domain)) return true;
    const g = await this.always();
    if (g.some((x) => x.domain === domain)) return true;
    for (const k of this.onceGrants) if (k.startsWith(`${domain}|`)) return true;
    return false;
  }

  private key(domain: string, type: PermissionType, toolCallId: string) {
    return `${domain}|${type}|${toolCallId}`;
  }

  async authorize(i: AuthInput): Promise<AuthResult> {
    const p = await this.policy();
    let type: PermissionType | null = requiredPermission(i.tool, i.args);
    const isNav = i.tool === "navigate" || (i.tool === "tabs_create" && !!i.targetUrl);
    let urlForDomain = isNav && i.targetUrl ? i.targetUrl : i.url;
    let action = String(i.args.action ?? i.tool);
    const current = registrableDomain(i.url);

    if (isNav && i.targetUrl) {
      const target = registrableDomain(i.targetUrl);
      if (current && target && current !== target && i.tool === "navigate") {
        // SEC-05: leaving the domain needs its own approval unless the destination is already approved.
        if (!(await this.isApproved(target, i.groupId))) type = "DOMAIN_TRANSITION";
      }
    } else if (i.linkTargetUrl) {
      const target = registrableDomain(i.linkTargetUrl);
      if (target && target !== current && !(await this.isApproved(target, i.groupId))) {
        type = "DOMAIN_TRANSITION";
        urlForDomain = i.linkTargetUrl;
        action = `${action} -> link to ${target}`;
      }
    }

    const domain = registrableDomain(urlForDomain);
    const category: DomainCategory = domain ? categorizeDomain(domain, p.policy) : "default";
    if (category === "blocked") {
      return { allowed: false, reason: `The domain ${domain} is blocked by the user or by policy.`, domain, decision: "blocked", category };
    }
    if (!type) return { allowed: true, domain, decision: "n/a", category };

    // SEC-10: sensitive fields always need a one-time approval, in every mode.
    let d = decide({
      mode: p.mode,
      type,
      domain,
      category,
      toolCallId: i.toolCallId,
      grants: [...(await this.always()), ...this.onceList()],
      planDomains: this.planFor(i.groupId),
    });
    if (i.sensitive && d.action === "allow") d = { action: "ask", onceOnly: true };
    // DOMAIN_TRANSITION into an approved domain never needs asking; handled above by isApproved.
    if (d.action === "deny") return { allowed: false, reason: d.reason, domain, decision: "denied", category };
    if (d.action === "allow") return { allowed: true, domain, decision: "auto", category };

    const req: ApprovalRequest = {
      id: crypto.randomUUID(),
      type: i.sensitive ? type : type,
      domain,
      tool: i.tool,
      action: i.sensitive ? `${action} (password / card field)` : action,
      preview: i.preview,
      onceOnly: !!d.onceOnly,
      toolCallId: i.toolCallId,
      plan: i.tool === "update_plan" ? { domains: (i.args.domains as string[]) ?? [], approach: (i.args.approach as string[]) ?? [] } : undefined,
    };
    const answer = await this.ui.ask(req, { groupId: i.groupId, mainTabId: i.mainTabId }, i.signal);
    if (answer === "deny") return { allowed: false, reason: "Declined by the user.", domain, decision: "user_denied", category };
    if (answer === "always" && !d.onceOnly && !i.sensitive) {
      const g = await this.always();
      g.push({ domain, type, scope: "always" });
      await chrome.storage.local.set({ grants: g });
      return { allowed: true, domain, decision: "user_always", category };
    }
    this.onceGrants.add(this.key(domain, type, i.toolCallId));
    return { allowed: true, domain, decision: "user_once", category };
  }

  private onceList(): ApprovalRecord[] {
    return [...this.onceGrants].map((k) => {
      const [domain, type, toolCallId] = k.split("|");
      return { domain, type: type as PermissionType, scope: "once" as const, toolCallId };
    });
  }

  /** Once-grants live only as long as their tool call (SEC-02). */
  endToolCall(toolCallId: string) {
    for (const k of [...this.onceGrants]) if (k.endsWith(`|${toolCallId}`)) this.onceGrants.delete(k);
  }
}
