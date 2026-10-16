import fs from "node:fs";
import path from "node:path";

/** AUX-08/09: absolute, existing paths below the working directory or an approved root. */
export function checkUploadPaths(paths: string[], cwd: string, extraRoots: string[]): { ok: true; paths: string[] } | { ok: false; error: string } {
  const roots = [cwd, ...extraRoots].map((r) => safeReal(r));
  const out: string[] = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) return { ok: false, error: `Path must be absolute: ${p}` };
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      return { ok: false, error: `File does not exist: ${p}` };
    }
    if (!fs.statSync(real).isFile()) return { ok: false, error: `Not a file: ${p}` };
    const inside = roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
    if (!inside) return { ok: false, error: `Path is outside the working directory and approved folders: ${p}. Add the folder to "uploadRoots" in ~/.pi/agent/browser-bridge.json.` };
    out.push(real);
  }
  return { ok: true, paths: out };
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
