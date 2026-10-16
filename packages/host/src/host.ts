/**
 * Headless host (API-02, panel-led mode): one pi session created through the SDK, with the same bridge
 * extension loaded. The side panel is then the only surface. Sessions can be replaced from the panel.
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createBridgeExtension } from "pi-browser-bridge";

export interface HostOptions {
  cwd: string;
  port?: number;
  provider?: string;
  model?: string;
  /** Extra extension files to load next to the bridge. */
  extensions?: string[];
  persistSessions?: boolean;
  log?: (message: string) => void;
}

export interface Host {
  runtime: AgentSessionRuntime;
  dispose(): Promise<void>;
}

export async function startHost(opts: HostOptions): Promise<Host> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let runtime!: AgentSessionRuntime;
  let switching = false;

  const bridge = createBridgeExtension({
    controller: {
      // The request arrives through the old session's bridge; answer first, switch right after.
      async newSession() {
        if (switching) throw new Error("A new session is already being created");
        switching = true;
        setTimeout(() => {
          void (async () => {
            try {
              await runtime.newSession();
              await runtime.session.bindExtensions({});
              log("Started a new session.");
            } catch (e: any) {
              log(`Could not start a new session: ${e?.message ?? e}`);
            } finally {
              switching = false;
            }
          })();
        }, 50);
        return { id: "new" };
      },
    },
    onNotify: (m: string) => log(m),
    pairOnStart: "if-unpaired",
  });

  const extensionFlagValues = new Map<string, boolean | string>();
  if (opts.port) extensionFlagValues.set("browser-port", String(opts.port));

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      extensionFlagValues,
      resourceLoaderOptions: { extensionFactories: [bridge], additionalExtensionPaths: opts.extensions ?? [] },
    });
    const model = opts.provider && opts.model ? services.modelRuntime.getModel(opts.provider, opts.model) : undefined;
    if (opts.provider && opts.model && !model) log(`Model ${opts.provider}/${opts.model} was not found; using pi's default.`);
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, ...(model ? { model } : {}) })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    sessionManager: opts.persistSessions === false ? SessionManager.inMemory(opts.cwd) : SessionManager.create(opts.cwd),
  });
  await runtime.session.bindExtensions({}); // fires session_start: the bridge starts listening
  log(`pi-browser-host ready (working directory ${opts.cwd}).`);
  return {
    runtime,
    async dispose() {
      await runtime.dispose();
    },
  };
}
