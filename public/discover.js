// Discover: a sortable table of pump.fun coins that are live on DexScreener (its latest profiles and
// boosts), with market cap, liquidity, volume and transactions for a chosen timeframe, a small
// price line, and a one-click buy. Filters come from filters.js.
import { passes, activeCount, openFilters, FILTER_ICON } from './filters.js';
import { fmtUsd, age } from './terminal.js';
import { safeUrl } from './safe.js';
import { popRows, slideTo } from './motion.js';

const TF = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };
const BOLT = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const COPY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const SOC = {
  twitter: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.2 2.3h3.3l-7.2 8.2 8.5 11.2h-6.6l-5.2-6.8-6 6.8H1.7l7.7-8.8L1.3 2.3h6.8l4.7 6.2z"/></svg>',
  telegram: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L6 13.6 1.1 12c-1.1-.3-1.1-1.1.2-1.6L20.5 3c.9-.3 1.7.2 1.4 1.3z"/></svg>',
  website: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>',
};

/** A five-point price line rebuilt from DexScreener's 24h, 6h, 1h and 5m changes. */
function spark(chg) {
  const pts = ['h24', 'h6', 'h1', 'm5'].map((k) => (chg?.[k] == null ? null : 1 / (1 + chg[k] / 100)));
  if (pts.every((v) => v == null)) return '';
  const vals = [...pts.map((v, i) => v ?? pts.slice(i + 1).find((x) => x != null) ?? 1), 1];
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i * 17.5).toFixed(1)} ${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join(' ');
  const up = (chg?.h24 ?? 0) >= 0;
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 70 30" aria-hidden="true"><path d="${d} L70 30 L0 30 Z" class="sf"/><path d="${d}" class="sl"/></svg>`;
}

export function createDiscover(ctx) {
  const { api, esc, copy } = ctx;
  const coins = new Map();
  let seed = [];
  let tf = 'h24';
  let sort = { key: 'vol', dir: -1 };
  let visible = false;
  let timers = [];
  let loading = true;
  let popNext = false;
  let tfShown = false;

  const metrics = (c) => ({
    mc: c.marketCap, liq: c.liquidity, vol: c.vol?.[tf] ?? null,
    tx: c.tx?.[tf] ? (c.tx[tf].buys || 0) + (c.tx[tf].sells || 0) : null,
    ageMin: c.createdAt ? (Date.now() - c.createdAt) / 60000 : null, progress: null,
  });

  async function loadSeed() {
    const r = await api('/api/pulse/seed');
    seed = r.mints || [];
    await loadMarket();
  }
  async function loadMarket() {
    for (let i = 0; i < seed.length; i += 30) {
      const r = await api(`/api/market?mints=${seed.slice(i, i + 30).join(',')}`);
      for (const [m, d] of Object.entries(r.coins || {})) coins.set(m, { mint: m, ...d });
    }
    loading = false;
    render();
  }

  function row(c) {
    const m = metrics(c);
    const ch = c.chg?.[tf];
    const t = c.tx?.[tf] || {};
    const soc = (c.socials || []).slice(0, 3).map((s) => {
      const x = s.type === 'twitter' || s.type === 'x';
      const icon = SOC[x ? 'twitter' : s.type] || SOC.website;
      return `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"${x ? ` data-xprev="${esc(safeUrl(s.url))}"` : ''}>${icon}</a>`;
    }).join('');
    return `<div class="dr" data-mint="${c.mint}">
      <div class="dc dc-pair">
        <a class="dr-img" href="#/trade?m=${c.mint}">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc((c.symbol || '?').slice(0, 2).toUpperCase())}</span>`}${c.boosts ? `<em class="dr-boost" title="Active DexScreener boosts">${c.boosts}</em>` : ''}</a>
        <div class="dr-id">
          <div class="dr-l1"><a class="dr-sym" href="#/trade?m=${c.mint}">${esc(c.symbol || '?')}</a><span class="dr-name">${esc(c.name || '')}</span><button type="button" class="pc-ca" data-copy="${c.mint}" title="Copy contract address">${COPY}</button></div>
          <div class="dr-l2"><span class="dr-age">${age(c.createdAt)}</span>${soc}<span class="dr-dex">${c.dex === 'pumpswap' ? 'PumpSwap' : c.dex === 'pumpfun' ? 'Bonding' : esc(c.dex || '')}</span></div>
        </div>
        ${spark(c.chg)}
      </div>
      <div class="dc dc-num"><b>${fmtUsd(m.mc)}</b>${ch == null ? '' : `<span class="${ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat'}">${ch >= 0 ? '+' : ''}${Number(ch).toFixed(1)}%</span>`}</div>
      <div class="dc dc-num"><b>${fmtUsd(m.liq)}</b></div>
      <div class="dc dc-num"><b>${fmtUsd(m.vol)}</b></div>
      <div class="dc dc-num"><b>${m.tx == null ? '-' : m.tx.toLocaleString()}</b><span><i class="up">${(t.buys ?? 0).toLocaleString()}</i> / <i class="down">${(t.sells ?? 0).toLocaleString()}</i></span></div>
      <div class="dc dc-info">${c.paid ? '<span class="chip ok">DEX paid</span>' : '<span class="chip">Not paid</span>'}${c.boosts ? `<span class="chip">${c.boosts} boosts</span>` : ''}${c.liquidity && m.mc ? `<span class="chip">Liq ${((c.liquidity / m.mc) * 100).toFixed(0)}% of MC</span>` : ''}</div>
      <div class="dc dc-act"><button type="button" class="buy-btn" data-qb="${c.mint}">${BOLT}Buy <span>${ctx.quickAmount()}</span> SOL</button></div>
    </div>`;
  }

  function render() {
    if (!visible) return;
    const body = document.getElementById('d-body');
    const list = [...coins.values()].filter((c) => c.solPair !== false && passes('discover', c, metrics(c)));
    const key = (c) => {
      const m = metrics(c);
      return sort.key === 'age' ? -(c.createdAt || 0) : m[sort.key] ?? -Infinity;
    };
    list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * sort.dir);
    body.innerHTML = list.length ? list.map(row).join('') : `<p class="pcol-empty">${loading ? 'Loading coins...' : coins.size ? 'No coin matches these filters.' : 'No coins right now.'}</p>`;
    const n = activeCount('discover');
    document.getElementById('d-filter-n').textContent = n ? n : '';
    document.querySelectorAll('#d-tf button').forEach((b) => b.classList.toggle('on', b.dataset.tf === tf));
    slideTo(document.querySelector('.tf-ind'), document.querySelector('#d-tf button.on'), !tfShown);
    tfShown = true;
    if (popNext && list.length) {
      popNext = false;
      popRows([...body.querySelectorAll('.dr')].slice(0, 14));
    }
    document.querySelectorAll('.dt-head [data-sort]').forEach((h) => {
      h.classList.toggle('on', h.dataset.sort === sort.key);
      h.dataset.dir = h.dataset.sort === sort.key ? (sort.dir < 0 ? 'down' : 'up') : '';
    });
  }

  document.getElementById('d-tf').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (!b) return;
    tf = b.dataset.tf;
    render();
  });
  document.querySelector('.dt-head').addEventListener('click', (e) => {
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    sort = sort.key === h.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: h.dataset.sort, dir: -1 };
    render();
  });
  document.getElementById('d-filter').addEventListener('click', () => openFilters('discover'));
  document.getElementById('d-body').addEventListener('click', (e) => {
    // a click anywhere on the coin (not on its own buttons or links) opens its chart
    if (!e.target.closest('a, button, input, label, [data-copy]')) {
      const hit = e.target.closest('.dr[data-mint]');
      if (hit) {
        const to = `#/trade?m=${hit.dataset.mint}`;
        if (e.ctrlKey || e.metaKey) window.open(to, '_blank');
        else location.hash = to;
        return;
      }
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) return copy(cp.dataset.copy, 'Contract address copied');
    const qb = e.target.closest('[data-qb]');
    if (qb) ctx.quickBuy(qb.dataset.qb, qb);
  });

  const safe = (fn) => () => fn().catch(() => {});
  return {
    show() {
      if (visible) return;
      visible = true;
      popNext = true;
      render();
      safe(loadSeed)();
      timers = [setInterval(safe(loadMarket), 15_000), setInterval(safe(loadSeed), 60_000)];
    },
    hide() {
      visible = false;
      timers.forEach(clearInterval);
      timers = [];
    },
    render,
    coin: (m) => coins.get(m),
    TF,
  };
}

export { FILTER_ICON };
