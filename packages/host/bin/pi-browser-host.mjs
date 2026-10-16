#!/usr/bin/env node
// Small launcher: the sources are TypeScript, loaded on the fly with jiti (the same loader pi uses for extensions).
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
await jiti.import("../src/cli.ts");
