/**
 * A scripted "model" for end-to-end tests with a real pi process (no network, no API key).
 * FAKE_LLM_SCENARIO selects the script; each model request advances by the number of assistant messages so far.
 */
import fs from "node:fs";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

type Call = { name: string; args: Record<string, unknown> };
type Step = { text?: string; calls?: Call[] };

const lastToolText = (messages: any[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "toolResult") return (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  }
  return "";
};
const tabIdFrom = (messages: any[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "toolResult") {
      const t = (m.content ?? []).map((c: any) => c.text ?? "").join("\n");
      const x = /tabId (\d+)/.exec(t);
      if (x) return Number(x[1]);
    }
  }
  return 0;
};

const scenarios: Record<string, (i: number, messages: any[]) => Step> = {
  browse: (i, messages) => {
    const tabId = tabIdFrom(messages);
    if (i === 0) return { text: "Let me look at the browser.", calls: [{ name: "tabs_context", args: {} }] };
    if (i === 1) return { calls: [{ name: "computer", args: { action: "screenshot", tabId } }] };
    if (i === 2) return { calls: [{ name: "read_page", args: { tabId, filter: "interactive" } }] };
    if (i === 3) {
      const t = lastToolText(messages);
      const ref = /button "Increment" \[(ref_\d+)\]/.exec(t)?.[1];
      return { calls: [{ name: "computer", args: { action: "left_click", ref, tabId } }] };
    }
    return { text: `Finished: clicked the Increment button on tab ${tabId}.` };
  },
  batch: (i, messages) => {
    const tabId = tabIdFrom(messages);
    if (i === 0) return { calls: [{ name: "tabs_context", args: {} }] };
    if (i === 1) return { calls: [{ name: "read_page", args: { tabId, filter: "all" } }] };
    if (i === 2) {
      const t = lastToolText(messages);
      const first = /textbox "Your first name" \[(ref_\d+)\]/.exec(t)![1];
      const email = /textbox "Email" \[(ref_\d+)\]/.exec(t)![1];
      return { calls: [{ name: "browser_batch", args: { tabId, actions: [{ name: "form_input", input: { ref: first, value: "Grace" } }, { name: "form_input", input: { ref: email, value: "grace@example.com" } }] } }] };
    }
    return { text: "Form filled." };
  },
  slow: (i, messages) => {
    const tabId = tabIdFrom(messages);
    if (i === 0) return { calls: [{ name: "tabs_context", args: {} }] };
    if (i === 1) return { text: "Waiting for a while.", calls: [{ name: "computer", args: { action: "wait", duration: 25, tabId } }] };
    return { text: "never reached" };
  },
};

export default function (pi: any) {
  pi.registerProvider("fakellm", {
    name: "Fake LLM",
    baseUrl: "http://fake.invalid",
    apiKey: "fake",
    api: "fake-api",
    models: [{ id: "script", name: "Scripted", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      (async () => {
        const messages: any[] = context.messages ?? [];
        if (process.env.FAKE_LLM_DUMP) {
          try {
            const tools = (getCurrentTools(context.messages) ?? []) as any[];
            fs.appendFileSync(process.env.FAKE_LLM_DUMP, JSON.stringify({ systemPrompt: getCurrentSystemPrompt(context.messages), tools: tools.map((t) => t.name) }) + "\n");
          } catch (e) {
            fs.appendFileSync(process.env.FAKE_LLM_DUMP, JSON.stringify({ error: String(e) }) + "\n");
          }
        }
        const index = messages.filter((m) => m.role === "assistant").length;
        const scenario = scenarios[process.env.FAKE_LLM_SCENARIO ?? "browse"];
        const step = scenario(index, messages);
        const msg: any = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "pending", timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: msg });
        if (step.text) {
          msg.content.push({ type: "text", text: "" });
          const ci = msg.content.length - 1;
          stream.push({ type: "text_start", contentIndex: ci, partial: msg });
          for (const part of step.text.match(/.{1,12}/g) ?? []) {
            msg.content[ci].text += part;
            stream.push({ type: "text_delta", contentIndex: ci, delta: part, partial: msg });
            await new Promise((r) => setTimeout(r, 15));
          }
          stream.push({ type: "text_end", contentIndex: ci, content: step.text, partial: msg });
        }
        for (const c of step.calls ?? []) {
          const call = { type: "toolCall", id: `call_${index}_${c.name}`, name: c.name, arguments: c.args };
          msg.content.push(call);
          const ci = msg.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: ci, partial: msg });
          stream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(c.args), partial: msg });
          stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: call, partial: msg });
        }
        msg.stopReason = step.calls?.length ? "toolUse" : "stop";
        stream.push({ type: "done", reason: msg.stopReason, message: msg });
        stream.end();
      })().catch((e) => {
        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(e?.message ?? e), timestamp: Date.now() } } as any);
        stream.end();
      });
      return stream;
    },
  });
}
