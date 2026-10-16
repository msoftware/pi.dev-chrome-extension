import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { generateTree, newTreeState, type TreeEnv } from "../../extension/src/content/tree-core";

const dir = path.resolve(__dirname, "../fixtures/tree");
const env: TreeEnv = {
  viewport: { width: 1000, height: 800 },
  rect: () => ({ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }),
  style: () => ({ display: "block", visibility: "visible", opacity: "1" }),
};

/** TEST-02: the tree generator against stored DOM snapshots. Update with `vitest -u` after intended changes. */
describe("tree snapshots", () => {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html"))) {
    for (const filter of ["all", "interactive"]) {
      it(`${f} (${filter})`, async () => {
        const dom = new JSDOM(fs.readFileSync(path.join(dir, f), "utf8"), { runScripts: "dangerously" }); // inline scripts build shadow roots
        await new Promise((r) => setTimeout(r, 0));
        const r = generateTree(dom.window.document, newTreeState(), env, { filter, depth: 15, maxChars: 50_000 }) as any;
        expect(r.error).toBeUndefined();
        await expect(r.pageContent + "\n").toMatchFileSnapshot(`./__snapshots__/${f.replace(".html", "")}.${filter}.txt`);
      });
    }
  }
  it("never leaks sensitive values in any snapshot", () => {
    const texts = fs.readdirSync(path.resolve(__dirname, "__snapshots__")).map((f) => fs.readFileSync(path.resolve(__dirname, "__snapshots__", f), "utf8")).join("\n");
    expect(texts).not.toContain("correct horse");
    expect(texts).not.toContain("4111111111111111");
    expect(texts).not.toContain("SECRETTOKEN");
  });
});
