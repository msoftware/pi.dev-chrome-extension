/** SEC-08: re-check the tab before every changing action and before screenshots. */
import { registrableDomain, isHttpUrl } from "../common/domain";
import { tabState } from "./cdp";
import { sleep } from "./indicators";
import type { PermissionManager } from "./permissions";

export class SafetyError extends Error {}

/**
 * `expectedDomain` is the registrable domain the action was authorised for. A tab that has moved to another domain since
 * (redirect, script navigation) fails the check even if the new domain would be approved on its own.
 */
export async function preCheck(tabId: number, groupId: number, perms: PermissionManager, what: string, expectedDomain?: string): Promise<void> {
  const fail = (why: string) => new SafetyError(`Safety check before ${what} failed: ${why}. Nothing was done.`);
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw fail("the tab no longer exists");
  const st = tabState(tabId);
  // A navigation that is just starting: give it a moment, then judge by where it goes.
  if (st.navigating || tab.status === "loading") {
    await sleep(400);
    tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw fail("the tab no longer exists");
  }
  const url = tab.url ?? "";
  if (!isHttpUrl(url)) throw fail(`the tab shows "${url || "no page"}", which the agent may not operate`);
  const dom = registrableDomain(url);
  const cat = await perms.categoryOf(url);
  if (cat.category === "blocked") throw fail(`${dom} is blocked`);
  if (expectedDomain && dom !== expectedDomain) throw fail(`the tab moved from ${expectedDomain} to ${dom} after the action was approved`);
  if (!(await perms.isApproved(dom, groupId))) throw fail(`the tab moved to ${dom}, which is not approved`);
  if (tab.pendingUrl) {
    const pd = registrableDomain(tab.pendingUrl);
    const pc = await perms.categoryOf(tab.pendingUrl);
    if (pc.category === "blocked" || (expectedDomain && pd !== expectedDomain) || !(await perms.isApproved(pd, groupId))) {
      throw fail(`a navigation to ${pd || tab.pendingUrl} is in progress and that domain is not approved`);
    }
  }
}
