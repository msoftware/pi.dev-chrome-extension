import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

marked.setOptions({ gfm: true, breaks: true });

// KaTeX only for explicit math delimiters; handled before markdown so the markup survives parsing.
const MATH_BLOCK = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
const MATH_INLINE = /\\\(([\s\S]+?)\\\)/g;

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function renderMarkdown(src: string): string {
  const maths: string[] = [];
  let s = src.replace(MATH_BLOCK, (_m, a, b) => {
    maths.push(`<div class="math" data-display="1" data-tex="${escapeHtml(a ?? b)}"></div>`);
    return `\n\nMATH${maths.length - 1}MATH\n\n`;
  });
  s = s.replace(MATH_INLINE, (_m, a) => {
    maths.push(`<span class="math" data-tex="${escapeHtml(a)}"></span>`);
    return `MATH${maths.length - 1}MATH`;
  });
  let html = marked.parse(s, { async: false }) as string;
  html = html.replace(/MATH(\d+)MATH/g, (_m, i) => maths[Number(i)] ?? "");
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-tex", "data-display"], FORBID_TAGS: ["style", "form", "input", "button"] });
}

let shikiP: Promise<any> | null = null;
const LANGS: Record<string, () => Promise<any>> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  js: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  ts: () => import("shiki/langs/typescript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  sh: () => import("shiki/langs/bash.mjs"),
  shell: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  py: () => import("shiki/langs/python.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  md: () => import("shiki/langs/markdown.mjs"),
};
const canonical: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", shell: "bash", py: "python", md: "markdown" };

async function highlighter() {
  if (!shikiP) {
    shikiP = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ]);
      return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
    })();
  }
  return shikiP;
}

/** UI-15: code, diagrams and formulas are loaded on demand only. */
async function enhance(root: HTMLElement) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre > code[class*='language-']"));
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  for (const code of blocks) {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1] ?? "";
    const pre = code.parentElement as HTMLElement;
    if (pre.dataset.done) continue;
    pre.dataset.done = "1";
    const text = code.textContent ?? "";
    if (lang === "mermaid") {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(`m${Math.random().toString(36).slice(2)}`, text);
        const holder = document.createElement("div");
        holder.className = "diagram";
        holder.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["foreignObject"] });
        pre.replaceWith(holder);
      } catch {
        /* keep the code block */
      }
      continue;
    }
    const loader = LANGS[lang];
    if (!loader) continue;
    try {
      const h = await highlighter();
      const name = canonical[lang] ?? lang;
      if (!h.getLoadedLanguages().includes(name)) await h.loadLanguage((await loader()).default);
      const html = h.codeToHtml(text, { lang: name, theme: dark ? "github-dark" : "github-light" });
      const holder = document.createElement("div");
      holder.className = "code-hl";
      holder.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["style"] });
      pre.replaceWith(holder);
    } catch {
      /* plain code block stays */
    }
  }
  const maths = Array.from(root.querySelectorAll<HTMLElement>(".math[data-tex]"));
  if (maths.length) {
    try {
      const katex = (await import("katex")).default;
      await import("katex/dist/katex.min.css");
      for (const el of maths) {
        if (el.dataset.done) continue;
        el.dataset.done = "1";
        katex.render(el.dataset.tex ?? "", el, { displayMode: el.dataset.display === "1", throwOnError: false, trust: false });
      }
    } catch {
      /* formulas stay as text */
    }
  }
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!streaming && ref.current) void enhance(ref.current);
  }, [html, streaming]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
