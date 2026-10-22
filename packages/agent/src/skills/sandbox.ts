// The sandbox for skills written at L3 (§9): generated code gets an isolated V8 heap (isolated-vm) with a memory cap,
// a budget of CPU time for the code itself, a wall-clock limit for the whole run, and a cap on skill calls. Inside
// there is only the skill API: the agent's own verified skills by name, what it can see of itself, and a log. No
// Node, no network, no files, nothing of the host. isolated-vm is an optional dependency: without it, no skill is
// written or run, and the agent says so once in its log.

import type IsolatedVM from 'isolated-vm';

/** What a learned skill may do: run a verified skill (its postcondition checked as always), look, note something. */
export interface SandboxApi {
  skill(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; observed: string; error?: string }>;
  look(): Record<string, unknown>;
}

export interface SandboxLimits {
  memoryMb: number;
  /** CPU time the code itself may use (not counting the skills it runs, which happen outside). */
  cpuMs: number;
  /** The whole run, skills included. */
  wallMs: number;
  maxCalls: number;
}

export type SandboxResult = { ok: true; value: unknown; logs: string[]; calls: number } | { ok: false; error: string; logs: string[]; calls: number };

type Ivm = typeof IsolatedVM;

let loaded: Promise<Ivm | null> | null = null;

/** isolated-vm, if it is installed and loads (an optional native dependency); null otherwise. */
export function loadSandbox(): Promise<Ivm | null> {
  loaded ??= import('isolated-vm')
    .then((m: unknown) => {
      const mod = m as { default?: Ivm } & Ivm;
      return mod.default ?? mod;
    })
    .catch(() => null);
  return loaded;
}

const MAX_LOGS = 40;
const WATCH_MS = 50;

/** The code of a learned skill, as the body of `async function (args, api) { ... }`. */
export async function runSandboxed(ivm: Ivm, code: string, args: Record<string, unknown>, api: SandboxApi, limits: SandboxLimits, signal?: AbortSignal): Promise<SandboxResult> {
  const isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
  const logs: string[] = [];
  let calls = 0;
  let why: string | null = null;
  const stop = (reason: string) => {
    why ??= reason;
    if (!isolate.isDisposed) isolate.dispose();
  };
  const started = Date.now();
  // The run's own timeout only covers the first synchronous slice; a loop after an await is caught here.
  const dog = setInterval(() => {
    if (isolate.isDisposed) return;
    if (Number(isolate.cpuTime) / 1e6 > limits.cpuMs) stop(`used more than ${limits.cpuMs} ms of CPU time`);
    else if (Date.now() - started > limits.wallMs) stop(`ran longer than ${Math.round(limits.wallMs / 1000)} s`);
  }, WATCH_MS);
  const onAbort = () => stop('stopped');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set(
      '__skill',
      // Never throws: a failure crosses as a result (a rejected host promise would surface as unhandled out here).
      new ivm.Reference(async (name: string, argsJson: string) => {
        if (++calls > limits.maxCalls) {
          stop(`more than ${limits.maxCalls} skill calls`);
          return JSON.stringify({ ok: false, observed: 'did not start', error: 'too many skill calls' });
        }
        try {
          const parsed: unknown = JSON.parse(String(argsJson));
          return JSON.stringify(await api.skill(String(name), parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}));
        } catch (err) {
          return JSON.stringify({ ok: false, observed: 'crashed', error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    await jail.set('__look', new ivm.Reference(() => JSON.stringify(api.look())));
    await jail.set(
      '__log',
      new ivm.Reference((line: string) => {
        if (logs.length < MAX_LOGS) logs.push(String(line).slice(0, 200));
      }),
    );
    // The API inside: plain functions over the references; only strings cross, so no host object ever gets in.
    await context.eval(
      `(() => {
         const s = globalThis.__skill, l = globalThis.__look, g = globalThis.__log;
         delete globalThis.__skill; delete globalThis.__look; delete globalThis.__log;
         globalThis.api = Object.freeze({
           skill: (name, args) => s.apply(undefined, [String(name), JSON.stringify(args ?? {})], { result: { promise: true } }).then(JSON.parse),
           look: () => JSON.parse(l.applySync(undefined, [])),
           log: (x) => { g.applySync(undefined, [String(x)]); },
         });
       })();`,
    );
    const script = await isolate.compileScript(`(async function (args, api) {\n${code}\n})(${JSON.stringify(args)}, api)`, { filename: 'learned-skill.js' });
    const value: unknown = await script.run(context, { promise: true, copy: true, timeout: limits.cpuMs });
    return { ok: true, value, logs, calls };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: why ?? msg.split('\n')[0] ?? 'failed', logs, calls };
  } finally {
    clearInterval(dog);
    signal?.removeEventListener('abort', onAbort);
    if (!isolate.isDisposed) isolate.dispose();
  }
}
