// The operator's controls on the page (debug controls): everything `pnpm ctl` can do, from the dashboard. Each request
// carries the control token (the RCON password from .env), kept for this tab only (sessionStorage). What the agents
// report back goes into the page as text (textContent), never as markup.

interface CtlResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

interface Inspect {
  goals?: { planText?: string | null; current?: { text?: string } | null };
  packet?: string;
  lastExchange?: { at: number; reason: string; tier: string; replies: { model: string | null; text: string; error?: string; rejected?: string }[] } | null;
  modules?: { name: string; on: boolean }[];
  routing?: { off?: boolean; tierModel?: Record<string, string>; moduleTier?: Record<string, string> } | null;
  chains?: Record<string, string[]> | null;
  flags?: { paused?: boolean };
}

interface MemoryRow {
  id: string;
  tier: string;
  text: string;
  ts: number;
  importance: number;
  source: string;
  isFalse?: boolean;
  score?: number;
}

const TOKEN_KEY = 'agora-ctl-token';
const TIERS = ['L1', 'L2', 'L3'] as const;
const MODULES = ['llm', 'cc.llm', 'talking.llm', 'goalGen', 'socialGoals', 'reflection', 'selfMonitor', 'impulses', 'conflict', 'romance', 'family', 'skillWriter'];
const MODULE_NOTES: Readonly<Record<string, string>> = {
  llm: 'every model call',
  'cc.llm': 'decides with the model',
  'talking.llm': 'speaks with the model',
  goalGen: 'makes and changes its plan',
  socialGoals: 'takes up village work',
  reflection: 'reflects on itself',
  selfMonitor: 'sums itself up',
  impulses: 'impulses and quirks',
  conflict: 'fights',
  romance: 'courting',
  family: 'families',
  skillWriter: 'writes new skills',
};
const FEELINGS = ['caution', 'fear', 'anger', 'joy', 'sadness', 'disgust', 'shame', 'envy', 'affection'];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<'cls' | 'text' | 'title' | 'type' | 'placeholder' | 'value' | 'name', string>> = {}, kids: (Node | string | null)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.cls) e.className = props.cls;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  if (props.type) e.setAttribute('type', props.type);
  if (props.placeholder) e.setAttribute('placeholder', props.placeholder);
  if (props.name) e.setAttribute('name', props.name);
  if (props.value !== undefined && 'value' in e) (e as unknown as HTMLInputElement).value = props.value;
  for (const k of kids) if (k !== null) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

function button(text: string, onClick: () => unknown, cls = ''): HTMLButtonElement {
  const b = h('button', { text, type: 'button', ...(cls ? { cls } : {}) });
  b.addEventListener('click', () => {
    b.disabled = true;
    void Promise.resolve(onClick()).finally(() => (b.disabled = false));
  });
  return b;
}

function select(options: readonly (string | [string, string])[], value = ''): HTMLSelectElement {
  const s = h('select');
  for (const o of options) {
    const [v, label] = typeof o === 'string' ? [o, o] : o;
    const opt = h('option', { text: label, value: v });
    if (v === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return h('label', { cls: 'field' }, [h('span', { text: label }), control]);
}

function token(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** One control command; a page without the token gets the server's refusal back as the message. */
export async function ctl(cmd: string, args: readonly string[] = []): Promise<CtlResult> {
  try {
    const r = await fetch('/api/ctl', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify({ cmd, args }) });
    return (await r.json()) as CtlResult;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Where a command's answer is shown: the message, and green or red by how it went. */
function report(out: HTMLElement, r: CtlResult): CtlResult {
  out.textContent = r.message;
  out.className = `ctl-out ${r.ok ? 'ok' : 'bad'}`;
  return r;
}

let models: string[] = [];
let personas: { id: string; name: string; sex: string }[] = [];

async function loadLists(): Promise<void> {
  const [m, p] = await Promise.all([ctl('models'), ctl('personas')]);
  if (m.ok && Array.isArray(m.data)) models = (m.data as { id: string }[]).map((x) => x.id);
  if (p.ok && Array.isArray(p.data)) personas = p.data as { id: string; name: string; sex: string }[];
}

export interface ControlsHooks {
  /** The world mode now ("test" or "live"), from the overview. */
  mode: () => string;
  /** Asks the page to refresh what it shows. */
  refresh: () => void;
}

/** The global controls card: token, test mode, population, a new agent, and settings for everyone. */
export function renderControls(root: HTMLElement, hooks: ControlsHooks): void {
  const out = h('pre', { cls: 'ctl-out', text: 'Enter the control token (RCON_PASSWORD in .env) to use the controls.' });
  const tok = h('input', { type: 'password', placeholder: 'control token', name: 'token' });
  tok.autocomplete = 'off';
  tok.value = token();
  const unlock = button('Use token', async () => {
    try {
      sessionStorage.setItem(TOKEN_KEY, tok.value.trim());
    } catch {
      // private mode: kept for this request only
    }
    const r = report(out, await ctl('status'));
    if (r.ok) {
      await loadLists();
      renderControls(root, hooks);
      report(root.querySelector<HTMLElement>('.ctl-out') ?? out, { ok: true, message: `controls unlocked (${models.length} subscription models, ${personas.length} personas)` });
    }
  });
  const testOn = hooks.mode() === 'test';
  const modeBtn = button(testOn ? 'Turn test mode off' : 'Turn test mode on', async () => {
    const turningOff = hooks.mode() === 'test';
    let r = await ctl('test-mode', [turningOff ? 'off' : 'on']);
    if (!r.ok && /--new-world/.test(r.message) && window.confirm(`${r.message}\n\nStart a fresh world for it? The old world stays in its folder.`)) r = await ctl('test-mode', [turningOff ? 'off' : 'on', '--new-world']);
    report(out, r);
  });
  const pop = h('input', { type: 'number', value: '' });
  pop.min = '0';
  pop.max = '50';
  pop.style.width = '5em';
  const persona = select([['', 'generated'], ...personas.map((p): [string, string] => [p.id, `${p.id} (${p.sex})`])]);
  const name = h('input', { placeholder: 'name (optional)' });
  const sex = select([['', 'any sex'], 'female', 'male']);
  const add = button('Add agent', async () => {
    const args = [...(persona.value ? [persona.value] : []), ...(name.value.trim() ? ['--name', name.value.trim()] : []), ...(sex.value ? ['--sex', sex.value] : [])];
    report(out, await ctl('add', args));
    hooks.refresh();
  });
  const mod = select(MODULES.map((m): [string, string] => [m, `${m}: ${MODULE_NOTES[m] ?? ''}`]));
  const tierSel = select(TIERS);
  const modelSel = select([['auto', 'auto (pick by itself)'], ...models.map((m): [string, string] => [m, m])]);
  const speech = select([['auto', 'own choice'], ...TIERS.map((t): [string, string] => [t, t])]);
  root.replaceChildren(
    h('div', { cls: 'card-head' }, [h('h2', { text: 'Controls' }), h('p', { cls: 'muted', text: 'The operator’s hands: outside the simulation, and every use is logged.' })]),
    h('div', { cls: 'ctl-row' }, [field('Control token', tok), unlock]),
    h('div', { cls: 'ctl-row' }, [
      h('span', { cls: 'badge', text: testOn ? 'test mode on' : 'test mode off (hardcore)' }),
      modeBtn,
      field('Population', pop),
      button('Set', async () => report(out, await ctl('population', [pop.value || '0']))),
      button('Pause everyone', async () => report(out, await ctl('pause', ['all']))),
      button('Resume everyone', async () => report(out, await ctl('resume', ['all']))),
    ]),
    h('div', { cls: 'ctl-row' }, [field('Persona', persona), field('Name', name), field('Sex', sex), add]),
    h('div', { cls: 'ctl-row' }, [
      field('Module for everyone', mod),
      button('On', async () => report(out, await ctl('module', ['all', mod.value, 'on']))),
      button('Off', async () => report(out, await ctl('module', ['all', mod.value, 'off']))),
    ]),
    h('div', { cls: 'ctl-row' }, [
      field('Tier', tierSel),
      field('Model for everyone', modelSel),
      button('Set model', async () => report(out, await ctl('model', ['all', tierSel.value, modelSel.value]))),
      field('Speech tier', speech),
      button('Set speech tier', async () => report(out, await ctl('tier', ['all', 'talking', speech.value]))),
    ]),
    out,
  );
}

/** The debug card for one agent: look inside, steer, and edit its memories. Rendered when the agent is picked. */
export function renderAgentDebug(root: HTMLElement, name: string | null, refresh: () => void): void {
  if (!name) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const out = h('pre', { cls: 'ctl-out', text: 'Inspect to see inside.' });
  const agent = (op: string, args: Record<string, unknown> = {}) => ctl('agent', [name, op, JSON.stringify(args)]);
  const inspector = h('div', { cls: 'inspect' });
  const modules = h('div', { cls: 'ctl-row' });
  const memList = h('div', { cls: 'table-wrap' });

  const showInspect = (d: Inspect) => {
    const ex = d.lastExchange;
    const replies = ex ? ex.replies.map((r) => `${r.model ?? '(no model)'}${r.error ? ` — ${r.error}` : ''}${r.rejected ? ` — rejected: ${r.rejected}` : ''}\n${r.text}`).join('\n\n') : 'no exchange with a model yet';
    inspector.replaceChildren(
      h('h3', { text: 'Plan' }),
      h('pre', { text: d.goals?.planText ?? `no plan; goal: ${d.goals?.current?.text ?? 'none'}` }),
      h('h3', { text: 'What its mind sees now (the packet)' }),
      h('pre', { text: d.packet ?? '' }),
      h('h3', { text: ex ? `Its last exchange with the model (${ex.tier}, ${new Date(ex.at).toLocaleTimeString()}: ${ex.reason})` : 'Its last exchange with the model' }),
      h('pre', { text: replies }),
      h('h3', { text: 'Models it uses' }),
      h('pre', { text: d.chains ? Object.entries(d.chains).map(([t, c]) => `${t}: ${c.join(' → ')}`).join('\n') : 'no models (code-only)' }),
      h('details', {}, [h('summary', { text: 'Everything (state)' }), h('pre', { text: JSON.stringify(d, null, 2) })]),
    );
    modules.replaceChildren(
      ...(d.modules ?? []).map((m) => {
        const box = h('input', { type: 'checkbox' });
        box.checked = m.on;
        box.addEventListener('change', () => void ctl('module', [name, m.name, box.checked ? 'on' : 'off']).then((r) => report(out, r)));
        return h('label', { cls: 'check', title: MODULE_NOTES[m.name] ?? '' }, [box, ` ${m.name}`]);
      }),
    );
  };
  const inspect = async () => {
    const r = report(out, await agent('inspect'));
    if (r.ok && r.data) showInspect(r.data);
  };

  const memRows = (rows: MemoryRow[]) => {
    const head = h('tr', {}, ['Memory', 'Importance', 'Source', ''].map((x) => h('th', { text: x })));
    const body = rows.map((m) => {
      const text = h('input', { value: m.text });
      text.style.width = '100%';
      const imp = h('input', { type: 'number', value: String(Math.round(m.importance * 100) / 100) });
      imp.step = '0.05';
      imp.min = '0';
      imp.max = '1';
      imp.style.width = '5em';
      return h('tr', {}, [
        h('td', {}, [text]),
        h('td', {}, [imp]),
        h('td', { cls: 'muted', text: `${m.source}${m.isFalse ? ' (false)' : ''}${m.score !== undefined ? ` · ${m.score}` : ''}` }),
        h('td', {}, [
          button('Save', async () => report(out, await agent('memory.edit', { id: m.id, text: text.value, importance: Number(imp.value) }))),
          button('Delete', async () => {
            if (!window.confirm('Delete this memory?')) return;
            report(out, await agent('memory.delete', { id: m.id }));
            await listMem();
          }),
        ]),
      ]);
    });
    memList.replaceChildren(h('table', { cls: 'data' }, [h('thead', {}, [head]), h('tbody', {}, body)]));
  };
  const q = h('input', { placeholder: 'search (blank: newest)' });
  const tier = select([['', 'all'], 'recent', 'long']);
  const listMem = async () => {
    const r = report(out, await agent('memory.list', { ...(q.value.trim() ? { q: q.value.trim() } : {}), ...(tier.value ? { tier: tier.value } : {}), limit: 60 }));
    if (!r.ok) return;
    const d = r.data as { memories?: MemoryRow[] } | MemoryRow[];
    memRows(Array.isArray(d) ? d : (d.memories ?? []));
  };
  const newMem = h('textarea', { placeholder: 'a memory to give it' });
  const newImp = h('input', { type: 'number', value: '0.6' });
  newImp.step = '0.05';
  newImp.style.width = '5em';
  const onMind = h('input', { type: 'checkbox' });

  const goal = h('input', { placeholder: 'goal, in its words' });
  const doneWhen = h('input', { placeholder: 'doneWhen (optional), e.g. inventoryHas:log>=8' });
  const aim = h('input', { placeholder: 'plan: what it is for' });
  const steps = h('textarea', { placeholder: 'one step a line' });
  const decision = h('textarea', { value: '{"option": "explore", "terminate": {"maxSeconds": 60}, "rationale": "the operator asked"}' });
  decision.rows = 3;
  const line = h('input', { placeholder: 'a line for it to say' });
  const feel = select(FEELINGS);
  const value = h('input', { type: 'number', value: '0.5' });
  value.step = '0.1';
  value.min = '0';
  value.max = '1';
  value.style.width = '5em';
  const tierSel = select(TIERS);
  const modelSel = select([['auto', 'auto'], ...models.map((m): [string, string] => [m, m])]);

  root.replaceChildren(
    h('div', { cls: 'card-head' }, [h('h2', { text: `Debug: ${name}` }), h('p', { cls: 'muted', text: 'Inspect, steer, switch modules, edit memories.' })]),
    h('div', { cls: 'ctl-row' }, [
      button('Inspect', inspect),
      button('Think now', async () => report(out, await agent('decide'))),
      button('Stop what it is doing', async () => report(out, await agent('abort'))),
      button('Pause', async () => report(out, await ctl('pause', [name]))),
      button('Resume', async () => report(out, await ctl('resume', [name]))),
      button('Restart', async () => report(out, await ctl('restart-agent', [name]))),
      button(
        'Remove',
        async () => {
          if (window.confirm(`${name} leaves for good (the population is one smaller). Go on?`)) report(out, await ctl('remove', [name]));
          refresh();
        },
        'danger',
      ),
      button(
        'Kill',
        async () => {
          if (window.confirm(`Kill ${name} in the world? It is a death like any other.`)) report(out, await ctl('kill', [name]));
        },
        'danger',
      ),
    ]),
    h('h3', { text: 'Modules (checked = on)' }),
    modules,
    h('div', { cls: 'ctl-row' }, [field('Tier', tierSel), field('Model', modelSel), button('Set model', async () => report(out, await ctl('model', [name, tierSel.value, modelSel.value])))]),
    h('h3', { text: 'Goal and plan' }),
    h('div', { cls: 'ctl-row' }, [goal, doneWhen, button('Set goal', async () => report(out, await agent('goal', { text: goal.value, ...(doneWhen.value.trim() ? { doneWhen: doneWhen.value.trim() } : {}) })))]),
    h('div', { cls: 'ctl-row' }, [
      aim,
      steps,
      button('Set plan', async () => report(out, await agent('plan', { aim: aim.value, steps: steps.value }))),
      button('New plan', async () => report(out, await agent('replan'))),
      button('Clear plan', async () => report(out, await agent('plan.clear'))),
    ]),
    h('h3', { text: 'Make it act' }),
    h('div', { cls: 'ctl-row' }, [decision, button('Do this', async () => report(out, await agent('do', { decision: decision.value })))]),
    h('div', { cls: 'ctl-row' }, [line, button('Say it', async () => report(out, await agent('say', { text: line.value })))]),
    h('div', { cls: 'ctl-row' }, [field('Feeling', feel), field('Value', value), button('Set', async () => report(out, await agent('set', { what: feel.value, value: Number(value.value) })))]),
    h('h3', { text: 'Memories' }),
    h('div', { cls: 'ctl-row' }, [q, tier, button('List', listMem)]),
    memList,
    h('div', { cls: 'ctl-row' }, [
      newMem,
      field('Importance', newImp),
      h('label', { cls: 'check' }, [onMind, ' on its mind now']),
      button('Add memory', async () => {
        report(out, await agent('memory.add', { text: newMem.value, importance: Number(newImp.value), ...(onMind.checked ? { mind: true } : {}) }));
        if (!onMind.checked) await listMem();
      }),
    ]),
    out,
    inspector,
  );
}
