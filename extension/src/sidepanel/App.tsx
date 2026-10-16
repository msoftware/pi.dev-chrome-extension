import { useEffect, useMemo, useState } from "react";
import { t } from "../common/i18n";
import { putShot } from "../common/idb";
import { getSettings } from "../common/storage";
import { ApprovalDialog, Composer, ConnectionBar, DialogCard, Messages, PrivacyNote, SessionMenu, ShortcutMenu, type Attachment } from "./components";
import { usePanel } from "./usePanel";

const LOCAL_PROVIDERS = /^(ollama|llama[-.]?cpp|lmstudio|local)/i;

export function App() {
  const tabId = useMemo(() => Number(new URLSearchParams(location.search).get("tabId") ?? "-1"), []);
  const { state, send, dispatch } = usePanel(tabId);
  const [menu, setMenu] = useState<null | "sessions" | "shortcuts">(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showThinking, setShowThinking] = useState(false);
  const { status } = state;

  useEffect(() => void getSettings().then((s) => setShowThinking(s.showThinking)), []);
  useEffect(() => {
    document.documentElement.lang = chrome.i18n?.getUILanguage?.().startsWith("de") ? "de" : "en";
  }, []);

  // attachments picked from the page (area / element) or captured
  useEffect(() => {
    const p = state.picked;
    if (!p) return;
    if ("error" in p) {
      dispatch({ type: "clearPicked" });
      return;
    }
    if (p.kind === "area" && p.imageData) setAttachments((a) => [...a, { id: crypto.randomUUID(), mimeType: p.mime ?? "image/jpeg", data: p.imageData!, name: t("areaShot") }]);
    if (p.kind === "element") {
      const note = `Selected element: ${p.selector}\nText: ${p.text ?? ""}${p.a11y ? `\nOutline:\n${p.a11y}` : ""}`;
      setAttachments((a) => [...a, { id: crypto.randomUUID(), mimeType: "text/plain", data: "", name: p.selector ?? "element", note: `${t("elementPicked")}: ${p.selector}` }]);
      setElementNotes((n) => [...n, note]);
    }
    dispatch({ type: "clearPicked" });
  }, [state.picked, dispatch]);
  const [elementNotes, setElementNotes] = useState<string[]>([]);
  useEffect(() => {
    const c = state.captured;
    if (!c) return;
    setAttachments((a) => [...a, { id: crypto.randomUUID(), mimeType: c.mimeType, data: c.data, name: t("pageShot") }]);
    dispatch({ type: "clearCaptured" });
  }, [state.captured, dispatch]);

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!state.toast) return;
    setToast(state.toast.message);
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [state.toast]);

  const connected = status?.bridge === "connected";
  const local = LOCAL_PROVIDERS.test(state.models?.current.model ?? "");

  const doSend = (text: string) => {
    const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
    const notes = elementNotes.join("\n\n");
    send({ t: "prompt", text: notes ? `${text}\n\n${notes}` : text, attachments: images.map((a) => ({ mimeType: a.mimeType, data: a.data, name: a.name })) });
    setAttachments([]);
    setElementNotes([]);
  };
  void putShot;

  return (
    <div className="app">
      <header>
        <h1>{t("extName")}</h1>
        <div className="hbtns">
          <button className="icon" aria-label={t("history")} aria-expanded={menu === "sessions"} title={t("history")} onClick={() => setMenu(menu === "sessions" ? null : "sessions")}>
            ☰
          </button>
          <button className="icon" aria-label={t("newChat")} title={t("newChat")} onClick={() => { dispatch({ type: "resetChat" }); send({ t: "newSession" }); }}>
            ＋
          </button>
          <button className="icon" aria-label={t("shortcuts")} aria-expanded={menu === "shortcuts"} title={t("shortcuts")} onClick={() => setMenu(menu === "shortcuts" ? null : "shortcuts")}>
            ⚡
          </button>
          <button
            className={`icon ${state.recording.active ? "rec" : ""}`}
            aria-label={state.recording.active ? t("stopRecording") : t("recordWorkflow")}
            title={state.recording.active ? `${t("stopRecording")} (${state.recording.steps})` : t("recordWorkflow")}
            onClick={() => send({ t: "recordWorkflow", action: state.recording.active ? "stop" : "start" })}
          >
            {state.recording.active ? "■" : "●"}
          </button>
          <button className="icon" aria-label={t("settings")} title={t("settings")} onClick={() => chrome.runtime.openOptionsPage()}>
            ⚙
          </button>
        </div>
        {menu === "sessions" && (
          <SessionMenu
            sessions={state.sessions}
            current={state.currentSession}
            onClose={() => setMenu(null)}
            onOpen={(id) => {
              setMenu(null);
              if (id === state.currentSession) dispatch({ type: "backToCurrent" });
              else send({ t: "loadSession", id });
            }}
          />
        )}
        {menu === "shortcuts" && (
          <ShortcutMenu
            onClose={() => setMenu(null)}
            onRun={(id, params) => {
              setMenu(null);
              send({ t: "runShortcut", id, params });
            }}
          />
        )}
      </header>

      {!state.connected && <div className="banner warn" role="status">{t("swReconnecting")}</div>}
      <ConnectionBar status={status} paired={state.paired} onPair={(code) => send({ t: "pair", code })} onUnpair={() => send({ t: "unpair" })} />

      {state.viewing && (
        <div className="banner" role="status">
          {t("viewingPast")}{" "}
          <button className="link" onClick={() => dispatch({ type: "backToCurrent" })}>
            {t("backToCurrent")}
          </button>
        </div>
      )}

      <Messages items={state.items} showThinking={showThinking} />

      <div className="overlays">
        {state.approvals.map((a) => (
          <ApprovalDialog key={a.id} req={a} onDecide={(decision) => send({ t: "approval", id: a.id, decision })} />
        ))}
        {Object.entries(state.dialogs)
          .filter(([, v]) => v)
          .map(([tid, info]) => (
            <DialogCard key={tid} info={info!} onAnswer={(accept, text) => send({ t: "dialogAnswer", tabId: Number(tid), accept, text })} />
          ))}
      </div>

      {toast && (
        <div className={`toast ${state.toast?.level ?? "info"}`} role="status" data-testid="toast">
          {toast}
        </div>
      )}

      <PrivacyNote local={local} />
      <Composer
        running={state.running}
        disabled={!connected || !!state.viewing}
        models={state.models}
        mode={status?.permissionMode ?? "ask"}
        locked={!!status?.policyLocked.permissionMode}
        attachments={attachments}
        onAttachments={setAttachments}
        onSend={doSend}
        onSteer={(text) => send({ t: "steer", text })}
        onStop={() => send({ t: "abort" })}
        onConfig={(c) => send({ t: "setConfig", ...c })}
        onPick={(kind) => send({ t: "pick", kind })}
        onCapture={() => send({ t: "captureTab" })}
      />
    </div>
  );
}
