import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ApprovalRequest, StatusInfo, ToolLogEntry } from "../common/messages";
import type { ModelsResponse, PermissionMode } from "@pi-browser/shared/protocol";
import { getShot } from "../common/idb";
import { getShortcuts, type Shortcut } from "../common/storage";
import { t } from "../common/i18n";
import { Markdown } from "./Markdown";
import type { ChatItem } from "./usePanel";

// ---- connection / pairing ---------------------------------------------------------------------------------------------

export function ConnectionBar({ status, paired, onPair, onUnpair }: { status: StatusInfo | null; paired: boolean; onPair: (code: string) => void; onUnpair: () => void }) {
  const [code, setCode] = useState("");
  const state = status?.bridge ?? "connecting";
  const needPair = state === "unpaired" || state === "unauthorized";
  const label =
    state === "connected" ? t("statusConnected") : state === "connecting" ? t("statusConnecting") : needPair ? t("statusPairing") : t("statusDisconnected");
  return (
    <section className="conn" aria-label={t("connection")}>
      <div className="conn-row">
        <span className={`dot ${state}`} aria-hidden="true" />
        <strong data-testid="status">{label}</strong>
        {state === "connected" && status?.model && <span className="muted"> · {status.model}</span>}
        {state === "connected" && paired && (
          <button className="link" onClick={onUnpair}>
            {t("unpair")}
          </button>
        )}
      </div>
      {state === "disconnected" && (
        <p className="help" data-testid="startup-help">
          {t("startHelp", String(status?.port ?? 47823))}
          <code>pi -e pi-browser-bridge</code>
        </p>
      )}
      {needPair && (
        <form
          className="pair"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{6}$/.test(code)) {
              onPair(code);
              setCode("");
            }
          }}
        >
          <p className="help">{state === "unauthorized" ? t("pairAgain") : t("pairHelp")}</p>
          <label className="sr-only" htmlFor="pair-code">
            {t("pairCode")}
          </label>
          <input id="pair-code" data-testid="pair-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <button className="primary" type="submit" disabled={code.length !== 6}>
            {t("pair")}
          </button>
        </form>
      )}
    </section>
  );
}

// ---- tool rows ----------------------------------------------------------------------------------------------------------------

function useShot(id: string | undefined) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!id) return;
    void getShot(id).then((s) => live && setSrc(s?.data ? `data:${s.mime};base64,${s.data}` : null));
    return () => {
      live = false;
    };
  }, [id]);
  return src;
}

function Shot({ id }: { id: string }) {
  const src = useShot(id);
  if (src === undefined) return null;
  if (src === null) return <div className="shot placeholder">{t("imageRemoved")}</div>;
  return <img className="shot" src={src} alt={t("screenshot")} loading="lazy" />;
}

export function ToolRow({ entry }: { entry: ToolLogEntry }) {
  const status = !entry.done ? "run" : entry.ok ? "ok" : "err";
  const shotIds = entry.screenshotIds ?? [];
  return (
    <details className={`tool ${status}`} data-testid="tool-row">
      <summary>
        <span className="tstate" aria-label={status === "run" ? t("running") : status === "ok" ? t("done") : t("failed")}>
          {status === "run" ? <span className="spin" /> : status === "ok" ? "✓" : "✕"}
        </span>
        <span className="tname">{entry.tool}</span>
        <span className="tsum">{entry.summary}</span>
        {shotIds.length > 0 && <span className="tcam" aria-hidden="true">📷</span>}
      </summary>
      <div className="tbody">
        {entry.progress && entry.progress.length > 0 && (
          <ol className="progress" aria-label={t("progress")}>
            {entry.progress.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ol>
        )}
        {entry.text && <pre className="tout">{entry.text}</pre>}
        {shotIds.slice(-2).map((id) => (
          <Shot key={id} id={id} />
        ))}
      </div>
    </details>
  );
}

export function ActivityRow({ item }: { item: Extract<ChatItem, { kind: "activity" }> }) {
  return (
    <div className={`tool activity ${item.done ? (item.isError ? "err" : "ok") : "run"}`}>
      <span className="tstate">{!item.done ? <span className="spin" /> : item.isError ? "✕" : "✓"}</span>
      <span className="tname">{item.toolName}</span>
      <span className="tsum">{item.summary}</span>
    </div>
  );
}

// ---- messages ---------------------------------------------------------------------------------------------------------------------

export function Messages({ items, showThinking }: { items: ChatItem[]; showThinking: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);
  return (
    <div
      className="messages"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      ref={boxRef}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {items.length === 0 && <p className="empty">{t("emptyChat")}</p>}
      {items.map((it) => {
        switch (it.kind) {
          case "user":
            return (
              <div key={it.id} className={`msg user ${it.source}`} data-testid="msg-user">
                {it.source === "terminal" && <span className="badge">{t("fromTerminal")}</span>}
                <div className="bubble">{it.text}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={it.id} className="msg assistant" data-testid="msg-assistant">
                {showThinking && it.thinking && (
                  <details className="thinking">
                    <summary>{t("thinking")}</summary>
                    <pre>{it.thinking}</pre>
                  </details>
                )}
                {it.text && <Markdown text={it.text} streaming={it.streaming} />}
                {it.streaming && <span className="cursor" aria-hidden="true" />}
              </div>
            );
          case "tool":
            return <ToolRow key={it.id} entry={it.entry} />;
          case "activity":
            return <ActivityRow key={it.id} item={it} />;
          case "error":
            return (
              <div key={it.id} className="msg error" role="alert">
                {it.text}
              </div>
            );
          case "notice":
            return (
              <div key={it.id} className="msg notice">
                {it.text}
              </div>
            );
        }
      })}
      <div ref={endRef} />
    </div>
  );
}

// ---- approval -------------------------------------------------------------------------------------------------------------------------

export function ApprovalDialog({ req, onDecide }: { req: ApprovalRequest; onDecide: (d: "once" | "always" | "deny") => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onDecide("deny");
  };
  return (
    <div className="approval" role="alertdialog" aria-modal="true" aria-labelledby={`ap-t-${req.id}`} onKeyDown={onKey} data-testid="approval" data-approval-id={req.id}>
      <h2 id={`ap-t-${req.id}`}>{req.type === "PLAN_APPROVAL" && req.plan ? t("approvePlan") : t("approveTitle")}</h2>
      <dl>
        {req.domain && (
          <>
            <dt>{t("domain")}</dt>
            <dd data-testid="approval-domain">{req.domain}</dd>
          </>
        )}
        <dt>{t("tool")}</dt>
        <dd>
          {req.tool} · {req.action}
        </dd>
        <dt>{t("permission")}</dt>
        <dd>{t(`perm_${req.type}`)}</dd>
      </dl>
      {req.plan ? (
        <div className="plan">
          <strong>{t("domains")}</strong> {req.plan.domains.join(", ") || "–"}
          <ol>
            {req.plan.approach.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        </div>
      ) : (
        <pre className="preview" data-testid="approval-preview">
          {req.preview.length > 1500 ? req.preview.slice(0, 1500) + "…" : req.preview}
        </pre>
      )}
      {req.onceOnly && <p className="muted small">{t("onceOnlyNote")}</p>}
      <div className="buttons">
        <button ref={first} className="primary" onClick={() => onDecide("once")} data-testid="allow-once">
          {t("allowOnce")}
        </button>
        {!req.onceOnly && req.type !== "PLAN_APPROVAL" && req.domain && (
          <button onClick={() => onDecide("always")} data-testid="allow-always">
            {t("allowAlways", req.domain)}
          </button>
        )}
        <button className="danger" onClick={() => onDecide("deny")} data-testid="deny">
          {t("deny")}
        </button>
      </div>
    </div>
  );
}

export function DialogCard({ info, onAnswer }: { info: { type: string; message: string; url: string }; onAnswer: (accept: boolean, text?: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="approval dialogcard" role="alertdialog" aria-label={t("pageDialog")} data-testid="page-dialog">
      <h2>{t("pageDialog")}</h2>
      <p className="preview">{info.message}</p>
      {info.type === "prompt" && <input aria-label={t("promptAnswer")} value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="buttons">
        <button className="primary" onClick={() => onAnswer(true, text)}>
          {t("accept")}
        </button>
        <button onClick={() => onAnswer(false)}>{t("dismiss")}</button>
      </div>
    </div>
  );
}

// ---- composer -----------------------------------------------------------------------------------------------------------------------------

export interface Attachment {
  id: string;
  mimeType: string;
  data: string;
  name: string;
  note?: string;
}

export function Composer(props: {
  running: boolean;
  disabled: boolean;
  models: ModelsResponse | null;
  mode: PermissionMode;
  locked: boolean;
  attachments: Attachment[];
  onAttachments: (a: Attachment[]) => void;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
  onConfig: (c: { model?: string; thinkingLevel?: string; permissionMode?: PermissionMode }) => void;
  onPick: (kind: "area" | "element") => void;
  onCapture: () => void;
}) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    const v = text.trim();
    if (!v && !props.attachments.length) return;
    (props.running ? props.onSteer : props.onSend)(v);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const addFile = (f: File) => {
    if (!f.type.startsWith("image/")) return;
    const r = new FileReader();
    r.onload = () => {
      const data = String(r.result).split(",")[1] ?? "";
      props.onAttachments([...props.attachments, { id: crypto.randomUUID(), mimeType: f.type, data, name: f.name || "image" }]);
    };
    r.readAsDataURL(f);
  };
  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        for (const f of Array.from(e.dataTransfer.files)) addFile(f);
      }}
    >
      {props.attachments.length > 0 && (
        <ul className="chips" aria-label={t("attachments")}>
          {props.attachments.map((a) => (
            <li key={a.id}>
              {a.mimeType.startsWith("image/") && <img alt="" src={`data:${a.mimeType};base64,${a.data}`} />}
              <span>{a.note ?? a.name}</span>
              <button aria-label={t("remove")} onClick={() => props.onAttachments(props.attachments.filter((x) => x.id !== a.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ta}
        data-testid="input"
        aria-label={t("messageLabel")}
        placeholder={props.running ? t("placeholderRunning") : t("placeholder")}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={(e) => {
          for (const f of Array.from(e.clipboardData.files)) addFile(f);
        }}
      />
      <div className="toolbar">
        <div className="tools-left">
          <button className="icon" title={t("captureTab")} aria-label={t("captureTab")} onClick={props.onCapture}>
            📷
          </button>
          <button className="icon" title={t("pickArea")} aria-label={t("pickArea")} onClick={() => props.onPick("area")}>
            ▭
          </button>
          <button className="icon" title={t("pickElement")} aria-label={t("pickElement")} onClick={() => props.onPick("element")}>
            ⌖
          </button>
        </div>
        <div className="send">
          {props.running && (
            <button className="danger" data-testid="stop" onClick={props.onStop}>
              ■ {t("stop")}
            </button>
          )}
          <button className="primary" data-testid="send" disabled={props.disabled} onClick={submit}>
            {props.running ? t("steer") : t("send")}
          </button>
        </div>
      </div>
      <div className="selects">
        <label>
          <span className="sr-only">{t("model")}</span>
          <select aria-label={t("model")} data-testid="model" value={props.models?.current.model ?? ""} onChange={(e) => props.onConfig({ model: e.target.value })} disabled={!props.models}>
            {!props.models?.current.model && <option value="">{t("noModel")}</option>}
            {props.models?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t("thinking")}</span>
          <select aria-label={t("thinking")} data-testid="thinking" value={props.models?.current.thinkingLevel ?? "off"} onChange={(e) => props.onConfig({ thinkingLevel: e.target.value })} disabled={!props.models}>
            {(props.models?.thinkingLevels ?? ["off"]).map((l) => (
              <option key={l} value={l}>
                {t("thinking")}: {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t("permissionMode")}</span>
          <select aria-label={t("permissionMode")} data-testid="mode" value={props.mode} disabled={props.locked} title={props.locked ? t("lockedByPolicy") : undefined} onChange={(e) => props.onConfig({ permissionMode: e.target.value as PermissionMode })}>
            <option value="ask">{t("modeAsk")}</option>
            <option value="plan">{t("modePlan")}</option>
            <option value="auto">{t("modeAuto")}</option>
          </select>
        </label>
      </div>
      {props.mode === "auto" && <p className="warn small">{t("autoWarning")}</p>}
    </div>
  );
}

// ---- menus ------------------------------------------------------------------------------------------------------------------------------

export function SessionMenu({ sessions, current, onOpen, onClose }: { sessions: { id: string; name: string; updatedAt: number }[]; current: string | null; onOpen: (id: string) => void; onClose: () => void }) {
  return (
    <div className="menu" role="menu" aria-label={t("history")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      {sessions.length === 0 && <p className="muted small pad">{t("noSessions")}</p>}
      {sessions.map((s) => (
        <button key={s.id} role="menuitem" className={s.id === current ? "cur" : ""} onClick={() => onOpen(s.id)}>
          <span>{s.name}</span>
          <time className="muted small">{new Date(s.updatedAt).toLocaleString()}</time>
        </button>
      ))}
    </div>
  );
}

export function ShortcutMenu({ onRun, onClose }: { onRun: (id: string, params: Record<string, string>) => void; onClose: () => void }) {
  const [list, setList] = useState<Shortcut[]>([]);
  const [open, setOpen] = useState<Shortcut | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => void getShortcuts().then(setList), []);
  return (
    <div className="menu" role="menu" aria-label={t("shortcuts")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      {list.length === 0 && <p className="muted small pad">{t("noShortcuts")}</p>}
      {list.map((s) => (
        <div key={s.id}>
          <button
            role="menuitem"
            onClick={() => {
              if (s.params?.length) setOpen(s);
              else onRun(s.id, {});
            }}
          >
            <span>{s.name}</span>
          </button>
          {open?.id === s.id && (
            <form
              className="pad"
              onSubmit={(e) => {
                e.preventDefault();
                onRun(s.id, vals);
              }}
            >
              {s.params!.map((p) => (
                <label key={p} className="field">
                  {p}
                  <input value={vals[p] ?? ""} onChange={(e) => setVals({ ...vals, [p]: e.target.value })} required />
                </label>
              ))}
              <button className="primary" type="submit">
                {t("run")}
              </button>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}

export function PrivacyNote({ local }: { local: boolean }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("privacyDismissed") === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <aside className="privacy" data-testid="privacy">
      <span>{local ? t("privacyLocal") : t("privacyCloud")}</span>
      <button
        aria-label={t("dismiss")}
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem("privacyDismissed", "1");
          } catch {
            /* ignore */
          }
        }}
      >
        ×
      </button>
    </aside>
  );
}
