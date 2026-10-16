// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { generateTree, newTreeState, extractMainText, type TreeEnv } from "../../extension/src/content/tree-core";

const env = (over: Partial<TreeEnv> = {}): TreeEnv => ({
  viewport: { width: 1000, height: 800 },
  rect: () => ({ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }),
  style: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  ...over,
});

function load(html: string) {
  document.body.innerHTML = html;
}
const gen = (opts: any = {}, state = newTreeState(), e = env()) => ({
  state,
  res: generateTree(document, state, e, { filter: "all", depth: 15, maxChars: 50_000, ...opts }) as any,
});

describe("tree (section 9)", () => {
  it("renders the form example from the requirements (TREE-03)", () => {
    load(`<form aria-label="Anmeldung">
      <label for="m">E-Mail</label><input id="m" type="email" placeholder="name@firma.de">
      <label for="p">Passwort</label><input id="p" type="password">
      <label for="l">Land</label><select id="l"><option value="de" selected>Deutschland</option><option value="at">Österreich</option></select>
      <input type="submit" value="Anmelden"></form>`);
    const { res } = gen();
    const out: string = res.pageContent;
    expect(out).toContain('form "Anmeldung" [ref_1]');
    // TREE-05 order: placeholder wins over <label for>; the label itself is still listed as its own line.
    expect(out).toMatch(/label "E-Mail" \[ref_\d+\]/);
    expect(out).toMatch(/textbox "name@firma.de" \[ref_\d+\] type="email" placeholder="name@firma.de"/);
    expect(out).toMatch(/textbox "Passwort" \[ref_\d+\] type="password"/);
    expect(out).toMatch(/combobox "Land" \[ref_\d+\]/);
    expect(out).toContain('option "Deutschland" (selected) value="de"');
    expect(out).toContain('option "Österreich" value="at"');
    expect(out).toMatch(/button "Anmelden" \[ref_\d+\] type="submit"/);
  });

  it("refs are stable across calls (TREE-10) and orphans fail (TREE-11)", () => {
    load(`<button id="a">One</button><button id="b">Two</button>`);
    const s = newTreeState();
    const first = gen({}, s).res.pageContent as string;
    const second = gen({}, s).res.pageContent as string;
    expect(second).toBe(first);
    const refB = /button "Two" \[(ref_\d+)\]/.exec(first)![1];
    document.getElementById("b")!.remove();
    const r = generateTree(document, s, env(), { filter: "all", depth: 15, maxChars: 1000, refId: refB }) as any;
    expect(r.error).toMatch(/no longer exists/);
    expect(s.refs.has(refB)).toBe(false);
  });

  it("ref_id starts at that element (TREE-02)", () => {
    load(`<div><button>Out</button><nav aria-label="N"><a href="/x">In</a></nav></div>`);
    const s = newTreeState();
    const full = gen({}, s).res.pageContent as string;
    const navRef = /nav "N" \[(ref_\d+)\]/.exec(full)![1];
    const sub = (generateTree(document, s, env(), { filter: "all", depth: 15, maxChars: 5000, refId: navRef }) as any).pageContent as string;
    expect(sub).toContain("nav");
    expect(sub).toContain('link "In"');
    expect(sub).not.toContain("Out");
  });

  it("redacts sensitive values (TREE-14) and shows short normal values (TREE-15)", () => {
    load(`<input type="password" value="hunter2"><input type="text" aria-label="n" value="Bob"><input type="text" aria-label="long" value="${"x".repeat(60)}"><input type="text" autocomplete="cc-number" aria-label="cc" value="4111">`);
    const out = gen().res.pageContent as string;
    expect(out).toContain('value="[value redacted]"');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("4111");
    expect(out).toContain('value="Bob"');
    expect(out).not.toContain("xxxxxxxxxx");
  });

  it("sensitive selects hide their options", () => {
    load(`<select autocomplete="one-time-code" aria-label="x"><option value="1">One</option></select>`);
    expect(gen().res.pageContent).not.toContain("option");
  });

  it("skips excluded tags and folds skipped wrappers (TREE-06)", () => {
    load(`<script>var a=1</script><style>.a{}</style><div><div><button>Deep</button></div></div>`);
    const out = gen().res.pageContent as string;
    expect(out).not.toContain("script");
    expect(out).toMatch(/^button "Deep"/m);
  });

  it("interactive filter keeps only visible controls in view (TREE-09)", () => {
    load(`<button id="in">In</button><button id="out">Out</button><button id="hid">Hid</button><p>text only</p>`);
    const rects: Record<string, any> = {
      in: { left: 10, top: 10, right: 60, bottom: 40, width: 50, height: 30 },
      out: { left: 10, top: 5000, right: 60, bottom: 5030, width: 50, height: 30 },
      hid: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    };
    const e = env({ rect: (el) => rects[(el as HTMLElement).id] ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } });
    const out = gen({ filter: "interactive" }, newTreeState(), e).res.pageContent as string;
    expect(out).toContain('"In"');
    expect(out).not.toContain('"Out"');
    expect(out).not.toContain('"Hid"');
    expect(out).not.toContain("text only");
    const all = gen({ filter: "all" }, newTreeState(), e).res.pageContent as string;
    expect(all).toContain('"Out"');
    expect(all).toContain('"Hid"');
  });

  it("traverses open shadow roots (TREE-16)", () => {
    load(`<div id="h"></div>`);
    const sr = document.getElementById("h")!.attachShadow({ mode: "open" });
    sr.innerHTML = `<button>Inside</button>`;
    expect(gen().res.pageContent).toContain('"Inside"');
  });

  it("truncates with a hint at maxChars (TREE-13)", () => {
    load(Array.from({ length: 200 }, (_, i) => `<button>Button number ${i}</button>`).join(""));
    const out = gen({ maxChars: 500 }).res.pageContent as string;
    expect(out).toContain("Output truncated");
    expect(out.length).toBeLessThan(900);
  });

  it("names: aria-label > placeholder > title > label (TREE-05)", () => {
    load(`<input aria-label="A" placeholder="P" title="T"><input placeholder="P2" title="T2"><input title="T3">`);
    const out = gen().res.pageContent as string;
    expect(out).toContain('"A"');
    expect(out).toContain('"P2"');
    expect(out).toContain('"T3"');
  });

  it("heading text up to 100 chars, role mapping (TREE-04)", () => {
    load(`<h2>${"w".repeat(150)}</h2><div role="tab">Tab</div><img alt="Logo"><input type="checkbox" aria-label="c">`);
    const out = gen().res.pageContent as string;
    expect(out).toMatch(/heading "w{100}" /);
    expect(out).toContain('tab "Tab"');
    expect(out).toContain('image "Logo"');
    expect(out).toContain("checkbox");
  });

  it("ref ranges per frame do not collide", () => {
    load(`<button>X</button>`);
    expect(gen({}, newTreeState(300000)).res.pageContent).toContain("ref_300001");
  });
});

describe("main text", () => {
  it("prefers article", () => {
    load(`<nav>menu</nav><article>${"Hello world. ".repeat(30)}</article><footer>foot</footer>`);
    const t = extractMainText(document, 100000);
    expect(t.text).toContain("Hello world.");
    expect(t.text).not.toContain("menu");
  });
});
