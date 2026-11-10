'use strict';
// Planes de Venus IA con dos familias (6.1, docs/implementacion/ia-dos-motores.md): catálogo de respaldo, tarjetas por
// familia con el selector "Claude | ChatGPT", saldos y el aviso de cambio de saldo. Sin Electron: DOM mínimo de pruebas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ui } = require('../../clipstudio/test/ui-harness');
// Los valores vienen de otro contexto de vm: se comparan como datos
const plain = (x) => JSON.parse(JSON.stringify(x));

const ROOT = path.resolve(__dirname, '../../../../../..');
const readDict = (file) => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'module.exports ='), ctx);
  return ctx.module.exports;
};
const dict = { plans: readDict(path.join(ROOT, 'src/renderer/i18n/es/plans.js')) };
const t = (key, vars = {}) => {
  const [ns, k] = key.split('.');
  const raw = dict[ns]?.[k];
  assert.equal(typeof raw, 'string', `Falta ${key}`);
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
};

// Carga un módulo de la interfaz sin sus import/export (los nombres pedidos vuelven en un objeto).
function load(file, names, deps) {
  const source = fs.readFileSync(file, 'utf8')
    .replace(/^export \{[^}]*\} from .*;\r?$/gm, '')
    .replace(/^import [\s\S]*? from .*;\r?$/gm, '')
    .replace(/^export /gm, '');
  return vm.runInNewContext(`${source}\n;({ ${names.join(', ')} });`, { console, setTimeout, clearTimeout, Intl, ...deps }, { filename: file });
}

const CATALOG_NAMES = ['FAMILIES', 'TIERS', 'MODEL_LABELS', 'PLAN_CATALOG', 'familyName', 'familyOf', 'tierOf', 'planDisplayName', 'familyPlans', 'currentPlans', 'planOverviewRows'];
const catalog = load(path.join(ROOT, 'src/renderer/js/features/plans-catalog.js'), CATALOG_NAMES, {});

function plansModule(extra = {}) {
  const dom = ui();
  const calls = [];
  const toasts = [];
  const notices = [];
  const deps = {
    ...dom.deps,
    ...catalog,
    t,
    ok: (...a) => notices.push(a),
    toast: (...a) => toasts.push(a),
    locale: () => 'es-AR',
    getLanguage: () => 'es',
    navigate() {},
    cloud: { on: (ch, fn) => { (extra.listeners || {})[`cloud:${ch}`] = fn; return () => {}; } },
    document: { activeElement: null },
    api: { invoke: async (ch, ...args) => { calls.push([ch, ...args]); return extra.invoke ? extra.invoke(ch, ...args) : null; }, on: (ch, fn) => { (extra.listeners || {})[ch] = fn; return () => {}; } },
  };
  // plansPanel usa contains() y childNodes, que el DOM mínimo no trae
  const proto = dom.Element.prototype;
  if (!('childNodes' in proto)) Object.defineProperty(proto, 'childNodes', { get() { return this.children; } });
  if (!proto.contains) proto.contains = function contains(el) { for (let x = el; x; x = x.parent) if (x === this) return true; return false; };
  const mod = load(path.join(ROOT, 'src/renderer/js/features/plans.js'), ['planCards', 'familySwitch', 'familyNotes', 'walletList', 'switchedText', 'notifySwitched', 'useWallet', 'mergeCatalog', 'plansPanel'], deps);
  return { ...mod, dom, calls, toasts, notices, deps };
}

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// Panel de planes montado: la pestaña elegida, el nombre del plan en uso y las tarjetas
const panelView = (panel) => {
  const [stateBox, familyBox, cardsPanel] = panel.children;
  return {
    family: familyBox.children[0].children.find((b) => b['aria-selected'] === 'true')?.dataset.family,
    name: stateBox.querySelector('.pl-current-name')?.textContent ?? null,
    notes: familyBox.children[1]?.textContent || '',
    current: cardsPanel.querySelectorAll('.current').length,
  };
};

test('panel: la pestaña inicial es una familia que se puede comprar si no hay plan ni saldo en uso', async () => {
  const gptPlans = ['basic', 'go', 'pro', 'max', 'ultra'].map((id) => ({ id, priceUsd: 10, budgetUsd: 6.75, available: true, prices: { mercado_pago: { currency: 'ARS', total: 1000, net: 900, taxes: [] } } }));
  const claudeOff = ['claude_basic', 'claude_go', 'claude_pro', 'claude_max', 'claude_ultra'].map((id) => ({ id, priceUsd: 10, budgetUsd: 6.75, available: false, prices: {} }));
  const open = async (plans, state = { active: false }) => {
    const m = plansModule({ invoke: async (ch) => (ch === 'billing:catalog' ? { source: 'backend', providers: { mercado_pago: true }, plans } : ch === 'billing:state' ? state : ch === 'assistant:status' ? { wallets: [] } : null) });
    const panel = m.plansPanel({ variant: 'modal' });
    await settle();
    return panelView(panel);
  };
  assert.equal((await open([...claudeOff, ...gptPlans])).family, 'openai', 'sin la clave de Anthropic');
  assert.equal((await open(gptPlans)).family, 'openai', 'servidor 6.0 o planes de Claude desactivados');
  assert.equal((await open([...claudeOff.map((p) => ({ ...p, available: true, prices: gptPlans[0].prices })), ...gptPlans])).family, 'anthropic', 'las dos a la venta: Claude');
  assert.equal((await open([...claudeOff, ...gptPlans], { active: true, plan: 'claude_pro', planName: 'Pro' })).family, 'anthropic', 'la del plan en uso');
});

test('panel: el nombre del plan sigue al saldo en uso y al cerrarse la sesión se va lo de la cuenta anterior', async () => {
  const listeners = {};
  let active = 'anthropic';
  let signedIn = true;
  const wallets = () => [
    { provider: 'anthropic', plan: 'claude_pro', planName: 'Pro', tier: 'pro', usedUsd: 1.2, limitUsd: 12.5, remainingUsd: 11.3, active: active === 'anthropic' },
    { provider: 'openai', plan: 'go', planName: 'Go', tier: 'go', usedUsd: 3.55, limitUsd: 6.75, remainingUsd: 3.2, active: active === 'openai' },
  ];
  const m = plansModule({
    listeners,
    invoke: async (ch) => {
      if (ch === 'billing:catalog') return null;
      if (ch === 'billing:state') {
        if (!signedIn) throw Object.assign(new Error('sin sesión'), { code: 'noSession' });
        return { active: true, plan: 'claude_pro', planName: 'Pro' };
      }
      if (ch === 'assistant:status') return signedIn ? { wallets: wallets() } : null;
      return null;
    },
  });
  const panel = m.plansPanel({ variant: 'modal' });
  await settle();
  assert.equal(panelView(panel).name, 'Claude Pro');
  // "Usar este" en ChatGPT: llega ai:quota y billing:state no se vuelve a pedir
  active = 'openai';
  listeners['ai:quota']({});
  await new Promise((r) => setTimeout(r, 350));
  await settle();
  assert.equal(panelView(panel).name, 'ChatGPT Go');
  assert.equal(m.calls.filter(([ch]) => ch === 'billing:state').length, 1);
  // Se cae la sesión con el panel abierto
  signedIn = false;
  listeners['cloud:auth']();
  await settle();
  const v = panelView(panel);
  assert.equal(v.current, 0, 'sin insignias de la cuenta anterior');
  assert.ok(!v.notes.includes('Tu saldo'), v.notes);
  assert.ok(panel.children[0].textContent.includes(t('plans.signInText')));
});

test('catálogo de respaldo: cinco niveles por familia con los precios, saldos, tokens y esfuerzos del contrato', () => {
  const rows = (family) => catalog.familyPlans(family).map((p) => [p.id, p.tier, p.price, p.budget, p.tokens, p.models.join('+'), p.efforts.join(',')]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows('anthropic'))), [
    ['claude_basic', 'basic', 6, 3.5, 12000, 'Haiku 5.5', 'low,medium'],
    ['claude_go', 'go', 10, 6.75, 32000, 'Haiku 5.5', 'low,medium,high'],
    ['claude_pro', 'pro', 18, 12.5, 44000, 'Haiku 5.5+Sonnet 5.5', 'low,medium,high'],
    ['claude_max', 'max', 32, 26, 78000, 'Haiku 5.5+Sonnet 5.5', 'low,medium,high,xhigh'],
    ['claude_ultra', 'ultra', 40, 32, 128000, 'Haiku 5.5+Sonnet 5.5', 'low,medium,high,xhigh,max'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows('openai'))), [
    ['basic', 'basic', 6, 3.5, 12000, 'GPT-6 Luna', 'low'],
    ['go', 'go', 10, 6.75, 32000, 'GPT-6 Luna', 'low,medium,high'],
    ['pro', 'pro', 18, 12.5, 44000, 'GPT-6 Luna', 'low,medium,high'],
    ['max', 'max', 32, 26, 78000, 'GPT-6 Luna+GPT-5.6 Sol', 'low,medium,high'],
    ['ultra', 'ultra', 40, 28, 128000, 'GPT-6 Luna+GPT-5.6 Sol', 'low,medium,high'],
  ]);
  assert.deepEqual(plain(catalog.FAMILIES.map((f) => f.id)), ['anthropic', 'openai'], 'Claude primero');
});

test('nombres visibles, familia y nivel: claude_basic se porta como basic; un plan viejo (sin provider) es de ChatGPT', () => {
  assert.equal(catalog.planDisplayName('claude_pro'), 'Claude Pro');
  assert.equal(catalog.planDisplayName({ plan: 'pro', planName: 'Pro' }), 'ChatGPT Pro');
  assert.equal(catalog.planDisplayName({ plan: 'max', planName: 'Max', provider: 'openai', tier: 'max' }), 'ChatGPT Max');
  assert.equal(catalog.planDisplayName({ plan: 'legacy_x', planName: 'Viejo' }), 'Viejo');
  assert.deepEqual(['claude_basic', 'basic', 'claude_ultra', 'nada'].map((x) => catalog.tierOf(x)), ['basic', 'basic', 'ultra', null]);
  assert.deepEqual([catalog.familyOf('claude_go'), catalog.familyOf('go'), catalog.familyOf({ id: 'go', provider: 'anthropic' }), catalog.familyOf('')], ['anthropic', 'openai', 'anthropic', null]);
  // Administración: los planes del servidor en el orden del catálogo, con la familia en el nombre
  const list = catalog.currentPlans([{ id: 'go', priceUsd: 10 }, { id: 'claude_go', priceUsd: 10 }, { id: 'viejo', priceUsd: 1 }]);
  assert.deepEqual(plain(list.map((p) => [p.id, p.name, p.family, p.tier])), [['claude_go', 'Claude Go', 'anthropic', 'go'], ['go', 'ChatGPT Go', 'openai', 'go']]);
  const rows = catalog.planOverviewRows([{ plan: 'claude_ultra', active: 3 }], true);
  assert.equal(rows.length, 10);
  assert.deepEqual([rows[4].name, rows[4].active, rows[0].active], ['Claude Ultra', 3, 0]);
});

test('tarjetas por familia: precios y límites del servidor, nombres "Claude Pro" y planes que no están a la venta', () => {
  const m = plansModule();
  const server = {
    source: 'backend',
    providers: { mercado_pago: true, paypal: false },
    plans: [
      { id: 'claude_pro', priceUsd: 19, budgetUsd: 13, maxTokensPerRequest: 40000, models: [{ id: 'haiku', label: 'Haiku 5.5', efforts: ['low'] }, { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium'] }], prices: { mercado_pago: { currency: 'ARS', total: 27600, net: 22809.92, taxes: [] } } },
      { id: 'go', priceUsd: 10, budgetUsd: 6.75, prices: {} },
    ],
  };
  const claude = m.planCards({ catalog: server, family: 'anthropic', current: ['claude_pro'] });
  assert.equal(claude.children.length, 1, 'con catálogo del servidor solo lo que está a la venta');
  const card = claude.children[0];
  assert.equal(card.dataset.plan, 'claude_pro');
  assert.ok(card.className.includes('current'));
  assert.ok(card.textContent.includes('Claude') && card.textContent.includes('Pro'));
  assert.ok(card.textContent.includes('Haiku 5.5 · Sonnet 5.5'));
  assert.ok(card.textContent.includes('40.000'), 'tokens del servidor');
  assert.ok(card.textContent.includes(t('plans.reasoning', { levels: 'bajo · medio' })));
  assert.ok(card.textContent.includes(t('plans.buyAgain')), 'comprar la misma familia suma saldo');
  const gpt = m.planCards({ catalog: server, family: 'openai' });
  assert.deepEqual(plain(gpt.children.map((c) => c.dataset.plan)), ['go']);
  assert.equal(gpt.children[0].querySelector('button').disabled, true, 'sin precio no se puede pagar');
  // Sin servidor: el respaldo completo, cinco por familia
  assert.equal(m.planCards({ catalog: null, family: 'openai' }).children.length, 5);
  assert.equal(m.planCards({ catalog: null }).children.length, 10);
});

test('selector "Claude | ChatGPT": pestañas con aria y flechas, Inicio y Fin', () => {
  const m = plansModule();
  const picks = [];
  const seg = m.familySwitch('anthropic', (f) => picks.push(f), 'panel-1');
  assert.equal(seg.role, 'tablist');
  const tabs = seg.children;
  assert.deepEqual(plain(tabs.map((b) => [b.dataset.family, b.role, b['aria-selected'], b.tabindex, b['aria-controls']])), [['anthropic', 'tab', 'true', 0, 'panel-1'], ['openai', 'tab', 'false', -1, 'panel-1']]);
  assert.ok(tabs[0].textContent.includes('Claude') && tabs[1].textContent.includes('ChatGPT'));
  const key = (k, from) => { m.deps.document.activeElement = from; seg.listeners.keydown({ key: k, preventDefault() {} }); };
  key('ArrowRight', tabs[0]);
  key('ArrowRight', tabs[1]);
  key('End', tabs[0]);
  key('Home', tabs[1]);
  key('a', tabs[0]);
  tabs[1].onclick();
  assert.deepEqual(picks, ['openai', 'anthropic', 'openai', 'anthropic', 'openai']);
});

test('notas de saldo: la misma familia suma, la otra no se toca', () => {
  const m = plansModule();
  const wallets = [{ provider: 'anthropic', plan: 'claude_pro', remainingUsd: 11.3, limitUsd: 12.5, active: true }];
  const same = m.familyNotes('anthropic', wallets).textContent;
  assert.ok(same.includes('Tu saldo de Claude') && same.includes('11,30') && same.includes('12,50') && same.includes('se suma'), same);
  const other = m.familyNotes('openai', wallets).textContent;
  assert.ok(other.endsWith(t('plans.walletOther', { family: 'ChatGPT', other: 'Claude' })) && !other.includes('Tu saldo'), other);
  assert.ok(m.familyNotes('openai', []).textContent.endsWith(t('plans.familyAbout_openai')));
});

test('saldos: el que está en uso, el otro con "Usar este" y uno vacío sin botón; elegir llama a assistant:useWallet', async () => {
  const m = plansModule({ invoke: async () => ({ wallets: [] }) });
  const list = m.walletList([
    { provider: 'anthropic', plan: 'claude_pro', planName: 'Pro', usedUsd: 1.2, limitUsd: 12.5, remainingUsd: 11.3, active: true },
    { provider: 'openai', plan: 'go', planName: 'Go', usedUsd: 3.55, limitUsd: 6.75, remainingUsd: 3.2, active: false },
  ]);
  const [claude, gpt] = list.children;
  assert.ok(claude.textContent.includes(t('plans.walletInUse')) && claude.textContent.includes('Saldo de Claude · Pro'));
  assert.equal(claude.querySelector('button'), null);
  const use = gpt.querySelector('button');
  assert.equal(use['aria-label'], t('plans.walletUseOf', { family: 'ChatGPT' }));
  await use.onclick({ currentTarget: use });
  assert.deepEqual(plain(m.calls), [['assistant:useWallet', 'openai']]);
  assert.deepEqual(plain(m.notices[0]), [t('plans.walletChanged', { family: 'ChatGPT' })]);
  const empty = m.walletList([{ provider: 'openai', plan: 'go', usedUsd: 6.75, limitUsd: 6.75, remainingUsd: 0, active: false }]);
  assert.equal(empty.children[0].querySelector('button'), null);
  assert.ok(empty.children[0].textContent.includes(t('plans.walletEmpty')));
  assert.equal(m.walletList([]), null, 'cuota vieja: nada');
});

test('aviso de cambio de saldo: textos de budget y noplan, y el toast para las otras funciones con IA', async () => {
  const m = plansModule();
  assert.equal(m.switchedText({ from: 'anthropic', to: 'openai', reason: 'budget' }), 'Se terminó tu saldo de Claude. Ahora estás usando tu saldo de ChatGPT.');
  assert.equal(m.switchedText({ from: 'openai', to: 'anthropic', reason: 'budget' }), 'Se terminó tu saldo de ChatGPT. Ahora estás usando tu saldo de Claude.');
  assert.equal(m.switchedText({ from: 'anthropic', to: 'openai', reason: 'noplan' }), t('plans.switchedNoplan', { from: 'Claude', to: 'ChatGPT' }));
  await m.notifySwitched({ from: 'anthropic', to: 'openai', reason: 'budget', task: 'text' });
  await m.notifySwitched({ from: 'x', to: 'openai' });
  assert.equal(m.toasts.length, 1);
  assert.deepEqual(plain(m.toasts[0].slice(0, 3)), ['info', t('plans.switchedTitle'), 'Se terminó tu saldo de Claude. Ahora estás usando tu saldo de ChatGPT.']);
});

test('asistente sin saldo: la familia del aviso solo con una cuota de la 6.1 (una vieja usa el texto de siempre)', () => {
  // quotaInfo de features/assistant.js, sola (el módulo entero necesita la interfaz)
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/features/assistant.js'), 'utf8');
  const fn = src.match(/^export function quotaInfo\(st\) \{[\s\S]*?^\}/m)[0].replace(/^export /, '');
  const quotaInfo = vm.runInNewContext(`${fn}\n;quotaInfo`, { ...catalog });
  const broke = [{ id: 'haiku', blocked: 'budget', resetAt: null }];
  const old = quotaInfo({ provider: 'backend', quota: { plan: 'go', planName: 'Go', status: 'active' }, planFamily: 'openai', modelOptions: broke });
  assert.deepEqual([old.blocked, old.reason, old.family], ['quota', 'budget', null], 'servidor 6.0: sin familia');
  const v3 = quotaInfo({ provider: 'backend', quota: { plan: 'go', planName: 'Go', provider: 'openai', status: 'active' }, planFamily: 'openai', modelOptions: broke });
  assert.equal(v3.family, 'openai');
});

test('textos nuevos de planes y del asistente en es/en con las mismas variables', () => {
  const variables = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
  for (const ns of ['plans', 'assistant']) {
    const es = readDict(path.join(ROOT, `src/renderer/i18n/es/${ns}.js`));
    const en = readDict(path.join(ROOT, `src/renderer/i18n/en/${ns}.js`));
    const keys = ns === 'plans'
      ? Object.keys(es).filter((k) => /^(effort_max|famil|maker_|wallet|switched|checkoutCarry|yourWallets|activeBalanceTwo)/.test(k))
      : ['effort_max', 'walletLabel', 'walletHint', 'walletOption', 'walletLine', 'failoverNoteOf', 'quotaBudgetTitle', 'quotaBudgetOut'];
    assert.ok(keys.length >= 8, ns);
    for (const k of keys) assert.equal(variables(en[k] || ''), variables(es[k]), `${ns}.${k}`);
  }
});
