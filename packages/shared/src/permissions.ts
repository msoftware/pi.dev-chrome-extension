export const PERMISSION_TYPES = [
  "NAVIGATE",
  "READ_PAGE_CONTENT",
  "CLICK",
  "TYPE",
  "EXECUTE_JS",
  "UPLOAD",
  "PLAN_APPROVAL",
  "DOMAIN_TRANSITION",
] as const;
export type PermissionType = (typeof PERMISSION_TYPES)[number];

/** Maps tool and computer-action names to the permission they need; `null` means none. */
export function requiredPermission(tool: string, args: Record<string, unknown> = {}): PermissionType | null {
  switch (tool) {
    case "navigate":
    case "tabs_create":
      return "NAVIGATE";
    case "read_page":
    case "find":
    case "get_page_text":
    case "read_console_messages":
    case "read_network_requests":
    case "__get_tree":
    case "__get_rects":
      return "READ_PAGE_CONTENT";
    case "form_input":
      return "TYPE";
    case "javascript_tool":
      return "EXECUTE_JS";
    case "upload_image":
    case "file_upload":
      return "UPLOAD";
    case "update_plan":
      return "PLAN_APPROVAL";
    case "computer":
      return computerActionPermission(String(args.action ?? ""));
    default:
      return null;
  }
}

export function computerActionPermission(action: string): PermissionType | null {
  switch (action) {
    case "screenshot":
    case "zoom":
    case "scroll":
    case "scroll_to":
      return "READ_PAGE_CONTENT";
    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click":
    case "hover":
    case "left_click_drag":
      return "CLICK";
    case "type":
    case "key":
      return "TYPE";
    default:
      return null;
  }
}

/** Actions that change page state; they trigger the SEC-08 pre-check. */
export function isMutatingAction(tool: string, args: Record<string, unknown> = {}): boolean {
  if (tool === "form_input" || tool === "javascript_tool" || tool === "file_upload" || tool === "upload_image") return true;
  if (tool === "computer") {
    return !["screenshot", "zoom", "scroll", "scroll_to", "wait"].includes(String(args.action ?? ""));
  }
  return false;
}

export type DomainCategory = "blocked" | "always_ask" | "allowed" | "default";

export interface PermissionPolicy {
  blockedDomains: string[];
  alwaysAskDomains: string[];
  allowedDomains: string[];
  /** Enterprise policy lists win over user lists. */
  policyBlocked?: string[];
  policyAllowed?: string[];
  policyAlwaysAsk?: string[];
}

export function categorizeDomain(domain: string, p: PermissionPolicy): DomainCategory {
  const inList = (l?: string[]) => !!l?.some((d) => d.toLowerCase() === domain);
  // Policy first, then user lists. Blocked beats everything within a level.
  if (inList(p.policyBlocked)) return "blocked";
  if (inList(p.policyAlwaysAsk)) return "always_ask";
  if (inList(p.policyAllowed)) return "allowed";
  if (inList(p.blockedDomains)) return "blocked";
  if (inList(p.alwaysAskDomains)) return "always_ask";
  if (inList(p.allowedDomains)) return "allowed";
  return "default";
}

/** Shipped starter list for "always ask" (banking, payments, government, health, password managers). */
export const DEFAULT_ALWAYS_ASK_DOMAINS: string[] = [
  // banking & brokers
  "paypal.com", "sparkasse.de", "commerzbank.de", "deutsche-bank.de", "ing.de", "dkb.de", "comdirect.de",
  "n26.com", "revolut.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "hsbc.com",
  "schwab.com", "fidelity.com", "etoro.com",
  // payments
  "stripe.com", "klarna.com", "wise.com", "venmo.com", "payoneer.com", "adyen.com",
  // government
  "irs.gov", "ssa.gov", "elster.de", "bund.de", "gov.uk", "service.bund.de", "finanzamt.de",
  // health
  "doctolib.de", "doctolib.com", "mychart.org", "tk.de", "aok.de",
  // password managers
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com", "proton.me",
];

export interface ApprovalRecord {
  domain: string;
  type: PermissionType;
  /** "once" is bound to a toolCallId; "always" persists for the domain. */
  scope: "once" | "always";
  toolCallId?: string;
}

export interface Decision {
  action: "allow" | "ask" | "deny";
  reason?: string;
  /** When asking, "once" is the only grant offered. */
  onceOnly?: boolean;
}

export interface DecideInput {
  mode: "ask" | "plan" | "auto";
  type: PermissionType | null;
  domain: string;
  category: DomainCategory;
  toolCallId: string;
  grants: ApprovalRecord[];
  planDomains: string[];
}

export function decide(i: DecideInput): Decision {
  if (i.category === "blocked") return { action: "deny", reason: "Domain is blocked" };
  if (!i.type) return { action: "allow" };
  const hasGrant = i.grants.some(
    (g) => g.domain === i.domain && g.type === i.type && (g.scope === "always" || g.toolCallId === i.toolCallId),
  );
  if (hasGrant && i.category !== "always_ask") return { action: "allow" };
  if (i.category === "always_ask") {
    const once = i.grants.some((g) => g.domain === i.domain && g.type === i.type && g.scope === "once" && g.toolCallId === i.toolCallId);
    return once ? { action: "allow" } : { action: "ask", onceOnly: true };
  }
  if (i.category === "allowed" && (i.type === "READ_PAGE_CONTENT" || i.type === "NAVIGATE")) return { action: "allow" };
  if (i.type === "PLAN_APPROVAL") return { action: "ask" };
  if (i.mode === "plan" && i.planDomains.includes(i.domain)) return { action: "allow" };
  if (i.mode === "auto") return { action: "allow" };
  return { action: "ask" };
}
