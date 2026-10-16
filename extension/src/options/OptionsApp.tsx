import { useCallback, useEffect, useState } from "react";
import type { ApprovalRecord } from "@pi-browser/shared/permissions";
import { t } from "../common/i18n";
import { clearAll, listAudit, type AuditRecord } from "../common/idb";
import { DEFAULT_SETTINGS, getSettings, saveSettings, getShortcuts, setShortcuts, setAuth, type Resolved, type Settings, type Shortcut } from "../common/storage";
import { nextRun, paramsOf } from "../background/shortcuts";

const COLORS: chrome.tabGroups.ColorEnum[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function Lines({ label, value, onChange, locked, hint }: { label: string; value: string[]; onChange: (v: string[]) => void; locked?: string[]; hint?: string }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="field">
      <span>{label}</span>
      {hint && <small className="muted">{hint}</small>}
      <textarea
        rows={5}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(text.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean))}
      />
      {locked && locked.length > 0 && (
        <small className="muted">
          {t("policyAdds")}: {locked.join(", ")}
        </small>
      )}
    </label>
  );
}

function download(name: string, mime: string, body: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function OptionsApp() {
  const [s, setS] = useState<Resolved | null>(null);
  const [grants, setGrants] = useState<ApprovalRecord[]>([]);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [shortcuts, setSc] = useState<Shortcut[]>([]);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setS(await getSettings());
    setGrants(((await chrome.storage.local.get("grants")).grants as ApprovalRecord[]) ?? []);
    setSc(await getShortcuts());
    setAudit(await listAudit());
  }, []);
  useEffect(() => void load(), [load]);

  const update = async (patch: Partial<Settings>) => {
    await saveSettings(patch);
    setS(await getSettings());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  if (!s) return null;
  const p = s.policy;

  const revoke = async (g: ApprovalRecord) => {
    const next = grants.filter((x) => !(x.domain === g.domain && x.type === g.type));
    await chrome.storage.local.set({ grants: next });
    setGrants(next);
  };

  const deleteAll = async () => {
    if (!confirm(t("confirmDeleteAll"))) return;
    await clearAll();
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await setAuth(null);
    await load();
    alert(t("deletedAll"));
  };

  const rows = audit.filter((a) => !filter || `${a.tool} ${a.action} ${a.domain} ${a.decision} ${a.result}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <main>
      <h1>
        {t("extName")} · {t("settings")} {saved && <span className="saved">✓ {t("saved")}</span>}
      </h1>

      <section>
        <h2>{t("optConnection")}</h2>
        <label className="field">
          <span>{t("optPort")}</span>
          <input type="number" min={1} max={65535} value={s.port} disabled={!!p.bridgePort} onChange={(e) => update({ port: Number(e.target.value) || DEFAULT_SETTINGS.port })} />
          {p.bridgePort && <small className="muted">{t("lockedByPolicy")}</small>}
        </label>
        <button onClick={async () => { await setAuth(null); alert(t("pairingRemoved")); }}>{t("unpair")}</button>
      </section>

      <section>
        <h2>{t("optPermissions")}</h2>
        <label className="field">
          <span>{t("permissionMode")}</span>
          <select value={s.permissionMode} disabled={!!p.permissionMode} onChange={(e) => update({ permissionMode: e.target.value as Settings["permissionMode"] })}>
            <option value="ask">{t("modeAsk")}</option>
            <option value="plan">{t("modePlan")}</option>
            <option value="auto">{t("modeAuto")}</option>
          </select>
          {p.permissionMode && <small className="muted">{t("lockedByPolicy")}</small>}
        </label>
        <div className="grid3">
          <Lines label={t("allowedDomains")} hint={t("allowedHint")} value={s.allowedDomains} onChange={(v) => update({ allowedDomains: v })} locked={p.allowedDomains} />
          <Lines label={t("alwaysAskDomains")} hint={t("alwaysAskHint")} value={s.alwaysAskDomains} onChange={(v) => update({ alwaysAskDomains: v })} locked={p.alwaysAskDomains} />
          <Lines label={t("blockedDomains")} hint={t("blockedHint")} value={s.blockedDomains} onChange={(v) => update({ blockedDomains: v })} locked={p.blockedDomains} />
        </div>
        <label className="check">
          <input type="checkbox" checked={s.jsToolEnabled} disabled={p.javascriptToolEnabled === false} onChange={(e) => update({ jsToolEnabled: e.target.checked })} />
          {t("jsTool")} {p.javascriptToolEnabled === false && <small className="muted">({t("lockedByPolicy")})</small>}
        </label>
        <h3>{t("savedGrants")}</h3>
        {grants.length === 0 ? (
          <p className="muted">{t("noGrants")}</p>
        ) : (
          <ul className="grants">
            {grants.map((g) => (
              <li key={`${g.domain}|${g.type}`}>
                <code>{g.domain}</code> · {t(`perm_${g.type}`)} <button onClick={() => revoke(g)}>{t("revoke")}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{t("optAgent")}</h2>
        <div className="grid3">
          <label className="field">
            <span>{t("groupTitle")}</span>
            <input value={s.groupTitle} onChange={(e) => update({ groupTitle: e.target.value || "Agent" })} />
          </label>
          <label className="field">
            <span>{t("groupColor")}</span>
            <select value={s.groupColor} onChange={(e) => update({ groupColor: e.target.value as Settings["groupColor"] })}>
              {COLORS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("gifQuality")}</span>
            <input type="number" min={1} max={30} value={s.gifQuality} onChange={(e) => update({ gifQuality: Number(e.target.value) || 10 })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.showThinking} onChange={(e) => update({ showThinking: e.target.checked })} />
          {t("showThinking")}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.notifySound} onChange={(e) => update({ notifySound: e.target.checked })} />
          {t("notifySound")}
        </label>
      </section>

      <section>
        <h2>{t("shortcuts")}</h2>
        <ShortcutEditor list={shortcuts} onChange={async (l) => { await setShortcuts(l); setSc(l); }} />
      </section>

      <section>
        <h2>{t("optLog")}</h2>
        <p className="muted">{t("logHelp")}</p>
        <div className="row">
          <input aria-label={t("filter")} placeholder={t("filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={() => download("audit-log.json", "application/json", JSON.stringify(rows, null, 2))}>{t("exportJson")}</button>
          <button
            onClick={() =>
              download(
                "audit-log.csv",
                "text/csv",
                ["time,session,tool,action,domain,decision,result,note", ...rows.map((r) => [new Date(r.ts).toISOString(), r.sessionId, r.tool, r.action, r.domain, r.decision, r.result, r.note ?? ""].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n"),
              )
            }
          >
            {t("exportCsv")}
          </button>
          <button onClick={load}>{t("refresh")}</button>
        </div>
        <div className="tablewrap">
          <table data-testid="audit-table">
            <thead>
              <tr>
                <th>{t("time")}</th>
                <th>{t("tool")}</th>
                <th>{t("action")}</th>
                <th>{t("domain")}</th>
                <th>{t("decision")}</th>
                <th>{t("result")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.ts).toLocaleString()}</td>
                  <td>{r.tool}</td>
                  <td>{r.action}</td>
                  <td>{r.domain}</td>
                  <td>{r.decision}</td>
                  <td className={r.result}>{r.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>{t("optData")}</h2>
        <p className="muted">{t("dataHelp")}</p>
        <button className="danger" onClick={deleteAll} data-testid="delete-all">
          {t("deleteAll")}
        </button>
      </section>
    </main>
  );
}

function ShortcutEditor({ list, onChange }: { list: Shortcut[]; onChange: (l: Shortcut[]) => void }) {
  const [draft, setDraft] = useState<Shortcut>({ id: "", name: "", prompt: "", schedule: null });
  const save = () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return;
    const sc: Shortcut = { ...draft, id: draft.id || crypto.randomUUID(), params: paramsOf(draft.prompt) };
    const next = list.some((x) => x.id === sc.id) ? list.map((x) => (x.id === sc.id ? sc : x)) : [...list, sc];
    onChange(next);
    setDraft({ id: "", name: "", prompt: "", schedule: null });
  };
  const sch = draft.schedule;
  return (
    <div>
      <ul className="grants">
        {list.map((x) => (
          <li key={x.id}>
            <strong>{x.name}</strong> {x.schedule && <small className="muted">({x.schedule.kind} {x.schedule.time}; {t("next")}: {new Date(nextRun(x.schedule)).toLocaleString()})</small>}
            <button onClick={() => setDraft(x)}>{t("edit")}</button> <button onClick={() => onChange(list.filter((y) => y.id !== x.id))}>{t("delete")}</button>
          </li>
        ))}
      </ul>
      <div className="grid2">
        <label className="field">
          <span>{t("name")}</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("schedule")}</span>
          <select value={sch?.kind ?? ""} onChange={(e) => setDraft({ ...draft, schedule: e.target.value ? { kind: e.target.value as any, time: sch?.time ?? "09:00", weekday: 1, day: 1 } : null })}>
            <option value="">{t("never")}</option>
            <option value="daily">{t("daily")}</option>
            <option value="weekly">{t("weekly")}</option>
            <option value="monthly">{t("monthly")}</option>
          </select>
        </label>
      </div>
      {sch && (
        <div className="row">
          <label className="field">
            <span>{t("timeOfDay")}</span>
            <input type="time" value={sch.time} onChange={(e) => setDraft({ ...draft, schedule: { ...sch, time: e.target.value } })} />
          </label>
          {sch.kind === "weekly" && (
            <label className="field">
              <span>{t("weekday")}</span>
              <select value={sch.weekday ?? 1} onChange={(e) => setDraft({ ...draft, schedule: { ...sch, weekday: Number(e.target.value) } })}>
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <option key={d} value={d}>
                    {new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: "long" })}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sch.kind === "monthly" && (
            <label className="field">
              <span>{t("dayOfMonth")}</span>
              <input type="number" min={1} max={28} value={sch.day ?? 1} onChange={(e) => setDraft({ ...draft, schedule: { ...sch, day: Number(e.target.value) } })} />
            </label>
          )}
        </div>
      )}
      <label className="field">
        <span>{t("promptLabel")}</span>
        <small className="muted">{t("promptHint")}</small>
        <textarea rows={4} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
      </label>
      <button className="primary" onClick={save}>
        {t("save")}
      </button>
    </div>
  );
}
