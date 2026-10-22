// The dashboard page (M7): polls the Hub's read-only API and draws what each agent is doing and why, what they
// say, who thinks what of whom, and what it all costs. Every name and line comes from the bots, so all of it goes
// into the page as text (textContent), never as markup.

interface Quota {
  level: number;
  codeOnly: boolean;
  reason: string;
  resetAt: number | null;
  weeklyPercent: number | null;
  remaining: number | null;
  unknown: boolean;
}
interface Usage {
  input: number;
  output: number;
  calls: number;
}
interface CostView {
  lastHour: Usage & { errors: number };
  inputPerHour: number;
  byModule: Record<string, Usage>;
  byTier: Record<string, Usage>;
  byAgent: Record<string, Usage>;
  total: Usage & { errors: number };
  projection: { exhaustAt: number | null; resetAt: number | null; beforeReset: boolean | null };
}
interface OptionView {
  option: string;
  status?: string;
  skill?: string;
  args?: Record<string, unknown>;
  progress?: string;
  target?: string;
  startedAt?: number;
}
interface AgentSummary {
  name: string;
  online: boolean;
  died?: { ts: number; cause: string };
  traits?: string[];
  sex?: string;
  health: number | null;
  food: number | null;
  goal: string | null;
  /** The role its last five social goals add up to (§6.8). */
  role: string | null;
  village: string[];
  option: OptionView | null;
  flags: { inDanger?: boolean; codeOnly?: boolean; degrade?: number } | null;
  rungs: Record<string, number>;
  mood: number | null;
  feeling: { name: string; intensity: number } | null;
  arousal: number;
  fear: number[];
  lastDecision: { ts: number; source: string; option: string; rationale: string } | null;
  sources: Record<string, number>;
  lastSeen: number;
}
type Row = { ts: number } & Record<string, unknown>;
interface Overview {
  now: number;
  startedAt: number;
  mode: string;
  online: number;
  quota: Quota | null;
  cost: CostView;
  agents: AgentSummary[];
  society: { roles: Record<string, number>; entropy: number; keywords: [string, number][] };
  power: {
    leaders: { name: string; followers: string[] }[];
    hour: { brawls: number; lethal: number; yields: number; kills: number; defections: number; uprisings: number; coerced: number };
  };
  couples: [string, string][];
  events: Row[];
  problems: Row[];
}
interface Person {
  name: string;
  sentiment: number;
  evidence: number;
  trust: number;
  admiration: number;
  fear: number;
  friction: number;
  resentment: number;
  rung: number;
  lastFight?: string;
}
interface AgentDetail extends AgentSummary {
  state: Row | null;
  people: Person[];
  decisions: Row[];
  actions: Row[];
  said: Row[];
  events: Row[];
}
interface Social {
  names: string[];
  cells: (Person & { from: string; to: string })[];
}

const $ = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
};
const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { cls?: string; text?: string; title?: string } = {}, kids: (Node | string | null)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.cls) e.className = props.cls;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  for (const k of kids) if (k !== null) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}
/** A table's "nothing here" line, across every column. */
function emptyRow(text: string): HTMLTableRowElement {
  const td = el('td', { cls: 'empty', text });
  td.colSpan = 99;
  return el('tr', {}, [td]);
}
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const compact = (n: number): string => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);
const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}
function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** How long from now until `ts`, short: "in 35 min", "in 5.2 h", "in 3 days". */
function until(ts: number, now: number): string {
  const m = Math.max(0, (ts - now) / 60_000);
  if (m < 90) return `in ${Math.round(m)} min`;
  if (m < 48 * 60) return `in ${(m / 60).toFixed(1)} h`;
  return `in ${Math.round(m / 1440)} days`;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v === null || v === undefined ? '' : JSON.stringify(v));

// ---- colors: the palette's tokens, read from CSS so light and dark each use their own steps ----
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function dark(): boolean {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark');
}
/** sRGB hex → OKLab, and back: scales are mixed in a perceptual space. */
function toLab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab([L, A, B]: [number, number, number]): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const enc = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  };
  const r = enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const b = enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
function mix(a: string, b: string, t: number): string {
  const x = toLab(a);
  const y = toLab(b);
  const k = Math.min(1, Math.max(0, t));
  return fromLab([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}
/** Sentiment 0..10 around a neutral 5: red for dislike, blue for liking, gray in between (diverging). */
function sentimentColor(v: number): string {
  const mid = dark() ? '#383835' : '#f0efec';
  const t = (v - 5) / 5;
  return t >= 0 ? mix(mid, dark() ? '#5598e7' : '#1c5cab', t) : mix(mid, dark() ? '#e66767' : '#b42b2b', -t);
}
/** Admiration 0..1: one hue, more is stronger (sequential). */
function admirationColor(v: number): string {
  return dark() ? mix('#0d366b', '#86b6ef', v) : mix('#cde2fb', '#104281', v);
}

// ---- tooltip: value first, then the label; same on focus as on hover ----
const tip = $('tooltip');
function tipFor(target: Element, value: string, label: string): void {
  const show = (x: number, y: number) => {
    tip.replaceChildren(el('strong', { text: value }), document.createTextNode(label));
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 12)}px`;
    tip.style.top = `${y + 14}px`;
  };
  target.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  target.addEventListener('pointerleave', () => (tip.hidden = true));
  target.addEventListener('focus', () => {
    const r = target.getBoundingClientRect();
    show(r.right, r.top);
  });
  target.addEventListener('blur', () => (tip.hidden = true));
}

// ---- state ----
let selected: string | null = null;
let lastChat = 0;
const tableView: Record<string, boolean> = {};
let overview: Overview | null = null;
let social: Social | null = null;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

// ---- header, banner and tiles ----
function renderHeader(o: Overview): void {
  $('mode').textContent = `${o.mode} mode`;
  $('uptime').textContent = `up ${duration(o.now - o.startedAt)}`;
  $('updated').textContent = `updated ${clock(o.now)}`;
}

function statusColor(level: number): string {
  return level >= 3 ? 'var(--critical)' : level === 2 ? 'var(--serious)' : level === 1 ? 'var(--warning)' : 'var(--good)';
}

function renderBanner(q: Quota | null): void {
  const b = $('banner');
  if (!q || (!q.codeOnly && q.level === 0)) {
    b.hidden = true;
    return;
  }
  const dot = el('span', { cls: 'dot' });
  dot.style.background = statusColor(q.codeOnly ? 3 : q.level);
  const when = q.resetAt ? `resets at ${new Date(q.resetAt).toLocaleString()}` : 'reset time unknown';
  const text = q.codeOnly ? `Quota exhausted, ${when}. Agents run code-only.` : q.unknown ? 'Quota unknown: saving tokens until NanoGPT answers.' : `Quota ${Math.round((q.weeklyPercent ?? 0) * 100)}% used: saving tokens (level ${q.level}), ${when}.`;
  b.replaceChildren(dot, el('span', { text }));
  b.hidden = false;
}

function tile(label: string, value: string, sub?: string, meter?: { frac: number; color: string }): HTMLElement {
  const t = el('div', { cls: 'tile' }, [el('div', { cls: 'label', text: label }), el('div', { cls: 'value', text: value }), sub ? el('div', { cls: 'sub', text: sub }) : null]);
  if (meter) {
    const fill = el('span');
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, meter.frac)) * 100)}%`;
    fill.style.background = meter.color;
    t.append(el('div', { cls: 'meter' }, [fill]));
  }
  return t;
}

function renderKpis(o: Overview): void {
  const q = o.quota;
  const used = q?.weeklyPercent ?? null;
  const p = o.cost.projection;
  const fights = o.events.filter((e) => e.what === 'fight' && o.now - e.ts < 3_600_000).length;
  const deaths = o.agents.filter((a) => a.died).length;
  $('kpis').replaceChildren(
    tile('Agents online', `${o.online}`, `${o.agents.length} known`),
    tile('Input tokens per hour', compact(o.cost.inputPerHour), `${o.cost.lastHour.calls} calls in the last hour`),
    tile('Weekly quota used', used === null ? '—' : `${Math.round(used * 100)}%`, q ? (q.codeOnly ? 'code-only until reset' : `level ${q.level}`) : 'no key: code-only', used === null ? undefined : { frac: used, color: statusColor(q?.level ?? 0) }),
    tile(
      'Quota runs out',
      p.exhaustAt ? until(p.exhaustAt, o.now) : '—',
      p.exhaustAt ? `${new Date(p.exhaustAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, ${p.beforeReset === null ? 'at this rate' : p.beforeReset ? 'before the reset' : 'after the reset (fine)'}` : 'not at this rate',
    ),
    tile('Roles', `${Object.keys(o.society.roles).length}`, Object.keys(o.society.roles).length > 0 ? `${o.society.entropy.toFixed(2)} bits of role entropy` : 'none taken up yet'),
    tile('Fights in the last hour', `${fights}`),
    tile('Deaths', `${deaths}`),
  );
}

// ---- agents table ----
function sparkline(values: number[]): SVGSVGElement {
  const w = 84;
  const h = 22;
  const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': `fear, latest ${(values.at(-1) ?? 0).toFixed(2)}` });
  if (values.length < 2) return s;
  const x = (i: number) => 2 + (i * (w - 8)) / (values.length - 1);
  const y = (v: number) => h - 3 - Math.min(1, Math.max(0, v)) * (h - 6);
  s.append(svg('line', { x1: 2, x2: w - 6, y1: h - 3, y2: h - 3, class: 'axis' }));
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  s.append(svg('path', { d, fill: 'none', stroke: token('--muted'), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = values.at(-1) ?? 0;
  s.append(svg('circle', { cx: x(values.length - 1), cy: y(last), r: 4, fill: token('--accent'), stroke: token('--surface'), 'stroke-width': 2 }));
  return s;
}

function doing(o: OptionView | null): string {
  if (!o) return 'idle';
  const what = o.skill ? `${o.skill}${o.args && Object.keys(o.args).length > 0 ? ` ${Object.values(o.args).map(str).join(' ')}` : ''}` : o.option;
  return `${what}${o.target ? ` with ${o.target}` : ''}${o.progress ? ` (${o.progress})` : ''}`;
}

function renderAgents(o: Overview): void {
  const t = $('agents');
  const head = el('thead', {}, [el('tr', {}, ['Agent', 'Health', 'Role', 'Goal', 'Doing', 'Why', 'Feeling', 'Fear', 'Decided by'].map((h, i) => el('th', { text: h, ...(i === 1 ? { cls: 'num' } : {}) })))]);
  const body = el('tbody');
  if (o.agents.length === 0) body.append(emptyRow('No agents yet.'));
  for (const a of o.agents) {
    const status = el('span', { cls: 'status', text: a.name });
    status.style.setProperty('--status-color', a.died ? 'var(--critical)' : a.online ? (a.flags?.inDanger ? 'var(--serious)' : 'var(--good)') : 'var(--muted)');
    const state = a.died ? `died: ${a.died.cause}` : a.online ? (a.flags?.inDanger ? 'in danger' : a.flags?.codeOnly ? 'code-only' : 'online') : 'offline';
    const sources = Object.entries(a.sources)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const tr = el('tr', { cls: `pick${selected === a.name ? ' selected' : ''}` }, [
      el('td', {}, [status, el('div', { cls: 'muted', text: state })]),
      el('td', { cls: 'num', text: a.health === null ? '—' : `${Math.round(a.health)}/20` }),
      el('td', { text: a.role ?? '—', title: a.village.length > 0 ? `For the village: ${a.village.join('; ')}` : '' }),
      el('td', { text: a.goal ?? '—' }),
      el('td', { text: doing(a.option) }),
      el('td', { cls: 'why', text: a.lastDecision ? `${a.lastDecision.rationale} (${a.lastDecision.source}, ${ago(a.lastDecision.ts, o.now)})` : '—' }),
      el('td', { text: a.feeling ? `${a.feeling.name} ${a.feeling.intensity.toFixed(1)}` : 'calm' }),
      el('td', {}, [sparkline(a.fear)]),
      el('td', { cls: 'muted', text: sources || '—' }),
    ]);
    tr.tabIndex = 0;
    const pick = () => {
      selected = selected === a.name ? null : a.name;
      void refreshDetail();
      renderAgents(o);
    };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    body.append(tr);
  }
  t.replaceChildren(head, body);
}

// ---- one agent ----
function list(title: string, rows: Row[], line: (r: Row) => (Node | string)[], now: number): HTMLElement {
  const ol = el('ol', { cls: 'feed' });
  if (rows.length === 0) ol.append(el('li', { cls: 'empty', text: 'Nothing yet.' }));
  for (const r of rows.slice(0, 30)) ol.append(el('li', {}, [el('time', { text: ago(r.ts, now) }), el('div', {}, line(r))]));
  return el('section', {}, [el('h3', { text: title }), ol]);
}

function peopleTable(people: Person[]): HTMLElement {
  const head = el('tr', {}, ['Person', 'Gut', 'Facts', 'Trust', 'Fear', 'Resentment', 'Rung', 'Last fight'].map((h, i) => el('th', { text: h, ...(i > 0 && i < 7 ? { cls: 'num' } : {}) })));
  const rows = people.map((p) =>
    el('tr', {}, [
      el('td', { text: p.name }),
      el('td', { cls: 'num', text: p.sentiment.toFixed(1) }),
      el('td', { cls: 'num', text: p.evidence.toFixed(1) }),
      el('td', { cls: 'num', text: p.trust.toFixed(2) }),
      el('td', { cls: 'num', text: p.fear.toFixed(2) }),
      el('td', { cls: 'num', text: p.resentment.toFixed(2) }),
      el('td', { cls: 'num', text: RUNG_NAMES[p.rung] ?? String(p.rung) }),
      el('td', { text: p.lastFight ?? '—' }),
    ]),
  );
  return el('div', { cls: 'table-wrap' }, [el('table', { cls: 'data' }, [el('thead', {}, [head]), el('tbody', {}, rows.length > 0 ? rows : [emptyRow('Knows nobody yet.')])])]);
}

function renderDetail(a: AgentDetail, now: number): void {
  const d = $('detail');
  const s = (a.state ?? {}) as Record<string, unknown>;
  const pos = s.pos as { x: number; y: number; z: number } | undefined;
  const facts = el('dl', { cls: 'kv' });
  const add = (k: string, v: string) => facts.append(el('dt', { text: k }), el('dd', { text: v }));
  if (a.traits) add('Persona', `${a.sex ?? ''} · ${a.traits.join(', ')}`);
  add('Position', pos ? `${pos.x}, ${pos.y}, ${pos.z}` : '—');
  add('Health / food', `${str(s.health) || '—'} / ${str(s.food) || '—'}`);
  add('Goal', a.goal ?? '—');
  add('Doing', doing(a.option));
  add('Mood', a.mood === null ? '—' : a.mood.toFixed(2));
  add('Caution', str(s.caution) || '—');
  add('At odds with', Object.entries(a.rungs).map(([n, r]) => `${n} (rung ${r})`).join(', ') || 'nobody');
  add('Carrying', Array.isArray(s.inventory) ? (s.inventory as string[]).join(', ') || 'nothing' : '—');
  add('Next up', Array.isArray(s.queue) ? (s.queue as string[]).join(', ') || '—' : '—');
  const decisions = list('Decisions and why', a.decisions, (r) => [el('span', { cls: 'who', text: `${str(r.option)}${r.task ? ` ${str((r.task as Record<string, unknown>).skill)}` : ''} ` }), el('span', { cls: 'muted', text: `[${str(r.source)}] ` }), str(r.rationale)], now);
  const actions = list('What it did', a.actions, (r) => [el('span', { cls: 'who', text: `${r.kind === 'option' ? `ended ${str(r.option)}` : str(r.skill)} ` }), `${r.ok === false ? 'failed: ' : ''}${str(r.kind === 'option' ? r.reason : (r.error ?? r.observed))}`], now);
  const said = list('What it said', a.said, (r) => [el('span', { cls: 'text', text: str(r.text) })], now);
  const events = list('Its events', a.events, (r) => [el('span', { cls: 'who', text: `${str(r.what)} ` }), str(r.with ?? r.text ?? r.reason ?? r.cause ?? '')], now);
  const close = el('button', { text: 'Close' });
  close.type = 'button';
  close.addEventListener('click', () => {
    selected = null;
    d.hidden = true;
    if (overview) renderAgents(overview);
  });
  d.replaceChildren(
    el('div', { cls: 'card-head' }, [el('h2', { text: a.name }), close]),
    el('div', { cls: 'detail-grid' }, [el('section', {}, [el('h3', { text: 'Now' }), facts]), decisions, actions, said, el('section', { cls: 'span-2' }, [el('h3', { text: 'People' }), peopleTable(a.people)]), events]),
  );
  d.hidden = false;
}

/** The escalation ladder (§17.5) as the people table shows it; rung 0 is no conflict at all. */
const RUNG_NAMES = ['—', 'hostile talk', 'threats', 'brawl', 'lethal'];

// ---- cost bars ----
function bars(title: string, data: Record<string, Usage>): HTMLElement {
  const entries = Object.entries(data).sort((a, b) => b[1].input - a[1].input);
  const box = el('section', {}, [el('h3', { text: title })]);
  if (entries.length === 0) {
    box.append(el('div', { cls: 'empty', text: 'No model calls in the last hour.' }));
    return box;
  }
  const rowH = 24;
  const labelW = 96;
  const w = 440;
  const max = Math.max(1, ...entries.map(([, v]) => v.input));
  const s = svg('svg', { viewBox: `0 0 ${w} ${entries.length * rowH + 4}`, width: '100%', role: 'img', 'aria-label': title });
  // Drawn at its own size (12 px text), only ever shrunk to fit a narrow screen.
  s.style.maxWidth = `${w}px`;
  entries.forEach(([k, v], i) => {
    const y = i * rowH + 2;
    const len = Math.max(2, ((w - labelW - 56) * v.input) / max);
    const label = svg('text', { x: labelW - 8, y: y + 15, 'text-anchor': 'end' });
    label.textContent = k;
    // A 4px rounded end, square at the baseline: a rounded rect plus a square patch over its baseline corners.
    const g = svg('g');
    g.append(svg('rect', { x: labelW, y: y + 4, width: len, height: 14, rx: 4, fill: token('--accent') }));
    g.append(svg('rect', { x: labelW, y: y + 4, width: Math.min(4, len), height: 14, fill: token('--accent') }));
    const hit = svg('rect', { x: labelW, y, width: w - labelW, height: rowH, fill: 'transparent', tabindex: 0 });
    tipFor(hit, `${compact(v.input)} input tokens`, `${k}: ${v.calls} calls, ${compact(v.output)} output`);
    const value = svg('text', { x: labelW + len + 6, y: y + 15, class: 'value' });
    value.textContent = compact(v.input);
    s.append(label, g, value, hit);
  });
  s.append(svg('line', { x1: labelW, x2: labelW, y1: 0, y2: entries.length * rowH + 4, class: 'axis' }));
  box.append(s);
  return box;
}

function costTable(c: CostView): HTMLElement {
  const rows: HTMLElement[] = [];
  for (const [group, data] of [
    ['module', c.byModule],
    ['tier', c.byTier],
    ['agent', c.byAgent],
  ] as const) {
    for (const [k, v] of Object.entries(data)) rows.push(el('tr', {}, [el('td', { text: group }), el('td', { text: k }), el('td', { cls: 'num', text: String(v.input) }), el('td', { cls: 'num', text: String(v.output) }), el('td', { cls: 'num', text: String(v.calls) })]));
  }
  const head = el('tr', {}, ['By', 'Name', 'Input', 'Output', 'Calls'].map((h, i) => el('th', { text: h, ...(i > 1 ? { cls: 'num' } : {}) })));
  return el('div', { cls: 'table-wrap' }, [el('table', { cls: 'data' }, [el('thead', {}, [head]), el('tbody', {}, rows.length > 0 ? rows : [emptyRow('No model calls in the last hour.')])])]);
}

function renderCost(c: CostView): void {
  $('cost').replaceChildren(...(tableView.cost ? [costTable(c)] : [bars('By module', c.byModule), bars('By tier', c.byTier), bars('By agent', c.byAgent)]));
}

// ---- social heatmaps ----
function heatmap(title: string, s: Social, value: (c: Person) => number, color: (v: number) => string, fmt: (v: number) => string, legend: [string, string, string]): HTMLElement {
  const names = s.names;
  const cell = 26;
  const gap = 2;
  const left = 92;
  const top = 78;
  const size = names.length * (cell + gap);
  const box = el('section', {}, [el('h3', { text: title })]);
  if (s.cells.length === 0) {
    box.append(el('div', { cls: 'empty', text: 'Nobody knows anybody yet.' }));
    return box;
  }
  const g = svg('svg', { viewBox: `0 0 ${left + size + 4} ${top + size + 4}`, width: '100%', role: 'img', 'aria-label': title });
  g.style.maxWidth = `${left + size + 4}px`;
  names.forEach((n, i) => {
    const row = svg('text', { x: left - 8, y: top + i * (cell + gap) + 17, 'text-anchor': 'end' });
    row.textContent = n;
    const col = svg('text', { x: 0, y: 0, transform: `translate(${left + i * (cell + gap) + 15},${top - 8}) rotate(-45)` });
    col.textContent = n;
    g.append(row, col);
  });
  const byPair = new Map(s.cells.map((c) => [`${c.from}>${c.to}`, c]));
  names.forEach((from, i) =>
    names.forEach((to, j) => {
      const c = byPair.get(`${from}>${to}`);
      if (!c) return;
      const v = value(c);
      const r = svg('rect', { x: left + j * (cell + gap), y: top + i * (cell + gap), width: cell, height: cell, rx: 3, fill: color(v), tabindex: 0 });
      tipFor(r, fmt(v), `${from} on ${to}: trust ${c.trust.toFixed(2)}, fear ${c.fear.toFixed(2)}, resentment ${c.resentment.toFixed(2)}${c.rung > 0 ? `, rung ${c.rung}` : ''}`);
      g.append(r);
    }),
  );
  const ramp = el('span', { cls: 'ramp' });
  ramp.style.background = `linear-gradient(90deg, ${color(value({ sentiment: 0, admiration: 0 } as Person))}, ${color(value({ sentiment: 5, admiration: 0.5 } as Person))}, ${color(value({ sentiment: 10, admiration: 1 } as Person))})`;
  box.append(g, el('div', { cls: 'legend' }, [el('span', { text: legend[0] }), ramp, el('span', { text: legend[2] }), el('span', { cls: 'muted', text: legend[1] })]));
  return box;
}

function socialTable(s: Social): HTMLElement {
  const head = el('tr', {}, ['From', 'To', 'Sentiment', 'Admiration', 'Trust', 'Fear', 'Rung'].map((h, i) => el('th', { text: h, ...(i > 1 ? { cls: 'num' } : {}) })));
  const rows = s.cells.map((c) => el('tr', {}, [el('td', { text: c.from }), el('td', { text: c.to }), el('td', { cls: 'num', text: c.sentiment.toFixed(1) }), el('td', { cls: 'num', text: c.admiration.toFixed(2) }), el('td', { cls: 'num', text: c.trust.toFixed(2) }), el('td', { cls: 'num', text: c.fear.toFixed(2) }), el('td', { cls: 'num', text: String(c.rung) })]));
  return el('div', { cls: 'table-wrap' }, [el('table', { cls: 'data' }, [el('thead', {}, [head]), el('tbody', {}, rows.length > 0 ? rows : [emptyRow('Nobody knows anybody yet.')])])]);
}

function renderSocial(s: Social): void {
  $('social').replaceChildren(
    ...(tableView.social
      ? [socialTable(s)]
      : [heatmap('Sentiment', s, (c) => c.sentiment, sentimentColor, (v) => `sentiment ${v.toFixed(1)}`, ['dislike', 'neutral at 5', 'like']), heatmap('Admiration', s, (c) => c.admiration, admirationColor, (v) => `admiration ${v.toFixed(2)}`, ['none', '0 to 1', 'idol'])]),
  );
}

// ---- feeds ----
function renderFeed(id: string, rows: Row[], now: number, line: (r: Row) => (Node | string)[], empty: string): void {
  const ol = $(id);
  const items = rows.map((r) => el('li', {}, [el('time', { text: ago(r.ts, now) }), el('div', {}, line(r))]));
  ol.replaceChildren(...(items.length > 0 ? items : [el('li', { cls: 'empty', text: empty })]));
}

const chatLines: Row[] = [];
function renderChat(now: number): void {
  renderFeed('chat', [...chatLines].reverse().slice(0, 120), now, (r) => [el('span', { cls: 'who', text: `${str(r.agent)}: ` }), el('span', { cls: 'text', text: str(r.text) }), r.volume && r.volume !== 'normal' ? el('span', { cls: 'muted', text: ` (${str(r.volume)})` }) : null].filter((x): x is HTMLElement => x !== null), 'Nobody has said anything yet.');
}

function eventText(r: Row): string {
  const w = str(r.what);
  if (w === 'died') return `died: ${str(r.cause)}`;
  if (w === 'left') return `left (${str(r.reason)})`;
  if (w === 'fight') return `fought ${str(r.with)}${r.lethal === true ? ' to the death' : ''}: ${str(r.outcome)}`;
  if (w === 'follows') return r.leader ? `follows ${str(r.leader)}` : `stopped following ${str(r.before)}`;
  if (w === 'defected') return `walked away from ${str(r.from)} as ${Array.isArray(r.attackers) ? (r.attackers as string[]).join(' and ') : 'others'} set upon them`;
  if (w === 'escalation') return `rung ${str(r.from)} → ${str(r.to)} with ${str(r.with)}`;
  if (w === 'impulse') return `acted on impulse: ${str(r.rationale)}`;
  if (w === 'conversation') return `talked with ${Array.isArray(r.participants) ? (r.participants as string[]).join(', ') : ''} (${str(r.turns)} turns, ${str(r.reason)})`;
  if (w === 'goal') return `${r.event === 'done' ? 'reached' : 'new'} goal: ${str(r.text)}`;
  if (w === 'commitment') return `${str(r.debtor)} owes ${str(r.creditor)} "${str(r.text)}": ${str(r.status)}`;
  return w;
}

// ---- the village (§6.8): who does what for it, who follows whom (§17.7), and what people talk about ----
function renderVillage(o: Overview): void {
  const byRole = new Map<string, string[]>();
  for (const a of o.agents) if (a.online && a.role) byRole.set(a.role, [...(byRole.get(a.role) ?? []), a.name]);
  const roles = [...byRole.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
  const rolesList = el('ol', { cls: 'feed' }, roles.length > 0 ? roles.map(([r, names]) => el('li', {}, [el('span', { cls: 'who', text: r }), el('span', { text: names.join(', ') })])) : [el('li', { cls: 'empty', text: 'Nobody has a role yet.' })]);
  const words = o.society.keywords;
  const talk = el('ol', { cls: 'feed' }, words.length > 0 ? words.map(([w, n]) => el('li', {}, [el('span', { cls: 'num', text: `${n}×` }), el('span', { text: w })])) : [el('li', { cls: 'empty', text: 'Nothing said in the last hour.' })]);
  // §17.7, §17.8: who follows whom (two or more followers make a leader), and the hour's fights and upheavals.
  const leaders = o.power.leaders;
  const followList = el(
    'ol',
    { cls: 'feed' },
    leaders.length > 0
      ? leaders.map((l) => el('li', {}, [el('span', { cls: 'who', text: `${l.name}${l.followers.length >= 2 ? ' (leader)' : ''}` }), el('span', { text: `followed by ${l.followers.join(', ')}` })]))
      : [el('li', { cls: 'empty', text: 'Nobody follows anybody.' })],
  );
  const h = o.power.hour;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const hour = el('p', {
    cls: 'muted',
    text: `${plural(h.brawls, 'brawl', 'brawls')}, ${plural(h.lethal, 'fight', 'fights')} to the death; ${plural(h.yields, 'yield', 'yields')}, ${plural(h.kills, 'kill', 'kills')}; ${plural(h.uprisings, 'uprising', 'uprisings')} agreed, ${plural(h.defections, 'defection', 'defections')}; ${plural(h.coerced, 'payment', 'payments')} under threat.`,
  });
  // §19.2: partners.
  const couples = el('ol', { cls: 'feed' }, o.couples.length > 0 ? o.couples.map(([a, b]) => el('li', {}, [el('span', { cls: 'who', text: `${a} and ${b}` })])) : [el('li', { cls: 'empty', text: 'No couples yet.' })]);
  $('village').replaceChildren(
    el('h3', { text: 'Roles' }),
    rolesList,
    el('h3', { text: 'Who follows whom' }),
    followList,
    el('h3', { text: 'Couples' }),
    couples,
    el('h3', { text: 'Power (last hour)' }),
    hour,
    el('h3', { text: 'What people talk about (last hour)' }),
    talk,
  );
}

// ---- refresh loops: a failed fetch keeps the last render, dimmed ----
async function refresh(): Promise<void> {
  const main = document.querySelector('main');
  try {
    const o = await get<Overview>('/api/overview');
    overview = o;
    renderHeader(o);
    renderBanner(o.quota);
    renderKpis(o);
    renderAgents(o);
    renderVillage(o);
    renderCost(o.cost);
    renderFeed('events', o.events, o.now, (r) => [el('span', { cls: 'who', text: `${str(r.agent)} ` }), eventText(r)], 'Nothing has happened yet.');
    renderFeed('problems', o.problems, o.now, (r) => [el('span', { cls: 'who', text: `${str(r.agent)} ${str(r.module)}: ` }), str(r.msg)], 'No problems.');
    const fresh = await get<Row[]>(`/api/chat?since=${lastChat}`);
    for (const l of fresh) chatLines.push(l);
    if (chatLines.length > 400) chatLines.splice(0, chatLines.length - 400);
    lastChat = chatLines.at(-1)?.ts ?? lastChat;
    renderChat(o.now);
    main?.classList.remove('stale');
  } catch {
    main?.classList.add('stale');
  }
}

async function refreshSocial(): Promise<void> {
  try {
    social = await get<Social>('/api/social');
    renderSocial(social);
  } catch {
    // keep the last one
  }
}

async function refreshDetail(): Promise<void> {
  if (!selected) {
    $('detail').hidden = true;
    return;
  }
  try {
    const a = await get<AgentDetail>(`/api/agents/${encodeURIComponent(selected)}`);
    renderDetail(a, overview?.now ?? Date.now());
  } catch {
    // keep the last one
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('button.toggle')) {
  b.addEventListener('click', () => {
    const k = b.dataset.table ?? '';
    tableView[k] = !tableView[k];
    b.textContent = tableView[k] ? 'Chart' : 'Table';
    if (k === 'cost' && overview) renderCost(overview.cost);
    if (k === 'social' && social) renderSocial(social);
  });
}

$('theme').addEventListener('click', () => {
  const next = dark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('agora-theme', next);
  } catch {
    // private mode: the choice just isn't remembered
  }
  if (overview) {
    renderAgents(overview);
    renderCost(overview.cost);
  }
  if (social) renderSocial(social);
});
try {
  const saved = localStorage.getItem('agora-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // no storage
}

void refresh();
void refreshSocial();
setInterval(() => void refresh(), 2000);
setInterval(() => void refreshSocial(), 5000);
setInterval(() => void refreshDetail(), 2000);
