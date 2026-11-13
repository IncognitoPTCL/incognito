// Pulse: three live columns of pump.fun coins (new pairs, final stretch, migrated), the discovery
// screen of the terminal. Sources, all keyless:
//   - PumpPortal's websocket for new coins and migrations (per-coin trade streams need a paid key,
//     so they are not used)
//   - each coin's bonding-curve account, read in one getMultipleAccounts call, for market cap in SOL
//     and bonding progress
//   - DexScreener (through /api/market) for USD market cap, volume, change and images
//   - DexScreener's latest profiles and boosts (/api/pulse/seed) to fill the columns on first load
import { fromB64 } from './sol.js';
import { passes, activeCount, openFilters } from './filters.js';
import { safeUrl } from './safe.js';
import { popRow, roll } from './motion.js';

const NEW_MAX = 40;
const FIN_MAX = 30;
const MIG_MAX = 40;
const SELLABLE = 793_100_000e6; // raw tokens a pump.fun curve sells before it completes
const BOLT = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const COPY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON = {
  twitter: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.2 2.3h3.3l-7.2 8.2 8.5 11.2h-6.6l-5.2-6.8-6 6.8H1.7l7.7-8.8L1.3 2.3h6.8l4.7 6.2z"/></svg>',
  telegram: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L6 13.6 1.1 12c-1.1-.3-1.1-1.1.2-1.6L20.5 3c.9-.3 1.7.2 1.4 1.3z"/></svg>',
  website: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>',
};

export const fmtUsd = (n) => (n == null || !Number.isFinite(n) ? '-' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 1 ? `$${n.toFixed(0)}` : `$${n.toPrecision(3)}`);
export const age = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`;
};

/** Decode a pump.fun bonding curve: reserves, completion, market cap in SOL, progress 0..1. */
export function readCurve(b64) {
  const b = fromB64(b64);
  if (b.length < 49) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const vTok = Number(dv.getBigUint64(8, true));
  const vSol = Number(dv.getBigUint64(16, true));
  const realTok = Number(dv.getBigUint64(24, true));
  const complete = b[48] === 1;
  // quote_mint at 83: all zeros (or wrapped SOL) means the coin is priced in SOL
  const quote = b.length >= 115 ? b.slice(83, 115) : new Uint8Array(32);
  const WSOL_BYTES = [6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26, 235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1];
  const solQuote = quote.every((x) => x === 0) || quote.every((x, i) => x === WSOL_BYTES[i]);
  return {
    complete,
    solQuote,
    mcapSol: vTok ? (vSol * 1e6) / vTok : null,
    progress: complete ? 1 : Math.min(1, Math.max(0, (SELLABLE - realTok) / SELLABLE)),
  };
}

export function createPulse(ctx) {
  const { api, rpc, esc, toast, copy } = ctx;
  const coins = new Map();
  const lists = { new: [], mig: [] };
  const els = new Map();
  const painted = new Set();
  let ws = null;
  let retry = 0;
  let visible = false;
  let solUsd = null;
  let seeded = false;
  let lastSeed = 0;
  let retryLists = 0;
  let timers = [];
  let dirty = false;
  const metaQueue = new Set();

  const coin = (mint) => {
    let c = coins.get(mint);
    if (!c) {
      c = { mint, name: '', symbol: '', image: null, createdAt: null, progress: null, mcapSol: null, socials: [] };
      coins.set(mint, c);
    }
    return c;
  };
  const live = (text, on = false) => {
    const el = document.getElementById('p-live');
    el.textContent = text;
    el.classList.toggle('on', on);
  };

  /* ---------------------------------------------------------------- feed */
  function connect() {
    if (ws && ws.readyState <= 1) return;
    live('Connecting');
    try {
      ws = new WebSocket('wss://pumpportal.fun/api/data');
    } catch {
      return live('Feed unavailable');
    }
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      live('Live', true);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.txType === 'create' && m.mint) onCreate(m);
      else if (m.txType === 'migrate' && m.mint) onMigrate(m);
    };
    ws.onclose = () => {
      ws = null;
      if (!visible) return;
      live('Reconnecting');
      setTimeout(connect, Math.min(15_000, 1000 * 2 ** retry++));
    };
  }

  function onCreate(m) {
    const c = coin(m.mint);
    Object.assign(c, {
      name: String(m.name || '').slice(0, 40), symbol: String(m.symbol || '').slice(0, 12), uri: m.uri, curve: m.bondingCurveKey,
      createdAt: Date.now(), mcapSol: m.marketCapSol ?? null, progress: m.vTokensInBondingCurve ? Math.max(0, (1_073_000_000 - m.vTokensInBondingCurve) / 793_100_000) : 0,
    });
    lists.new = [m.mint, ...lists.new.filter((x) => x !== m.mint)].slice(0, NEW_MAX);
    if (m.uri) metaQueue.add(m.mint);
    dirty = true;
  }

  function onMigrate(m) {
    const c = coin(m.mint);
    c.migratedAt = Date.now();
    c.progress = 1;
    lists.mig = [m.mint, ...lists.mig.filter((x) => x !== m.mint)].slice(0, MIG_MAX);
    dirty = true;
  }

  /* -------------------------------------------------------------- refresh */
  // Fill the columns from GeckoTerminal (/api/pulse/lists): the newest pump.fun launches, the
  // busiest bonding curves (their progress is then read on chain) and the busiest coins that
  // graduated in the last day. The websocket keeps adding live launches and migrations on top.
  // the last lists this browser saw, shown at once on the next visit (then refreshed)
  const SNAP = 'incognito:pulse:v1';
  function saveSnapshot() {
    try {
      const pick = (ids) => ids.slice(0, 40).map((m) => coins.get(m)).filter(Boolean)
        .map(({ mint, name, symbol, image, createdAt, migratedAt, curve, progress, mcapSol, marketCap, volume, change, dex, socials, uri }) =>
          ({ mint, name, symbol, image, createdAt, migratedAt, curve, progress, mcapSol, marketCap, volume, change, dex, socials, uri }));
      localStorage.setItem(SNAP, JSON.stringify({ at: Date.now(), new: pick(lists.new), mig: pick(lists.mig), fin: pick(finalStretch()) }));
    } catch { /* storage full or blocked */ }
  }
  function restoreSnapshot() {
    try {
      const s = JSON.parse(localStorage.getItem(SNAP) || 'null');
      if (!s || Date.now() - s.at > 30 * 60_000) return;
      const put = (list) => list.map((c) => { Object.assign(coin(c.mint), c, { socials: c.socials || [] }); return c.mint; });
      lists.new = [...new Set([...lists.new, ...put(s.new || [])])].slice(0, NEW_MAX);
      lists.mig = [...new Set([...lists.mig, ...put(s.mig || [])])].slice(0, MIG_MAX);
      put(s.fin || []);
      dirty = true;
    } catch { /* ignore a bad snapshot */ }
  }

  async function loadLists() {
    const r = await api('/api/pulse/lists');
    // an empty answer means the list source is rate limited for a moment: try again soon
    if (!(r.new || []).length && visible && !retryLists) retryLists = setTimeout(() => { retryLists = 0; loadLists().catch(() => {}); }, 6000);
    const take = (g) => {
      const c = coin(g.mint);
      c.name = c.name || g.name;
      c.symbol = c.symbol || g.symbol;
      c.image = c.image || g.image;
      if (!c.createdAt && g.createdAt) c.createdAt = g.createdAt;
      if (g.dex === 'pump-fun' && g.pool && !c.curve) c.curve = g.pool; // a pump-fun pool IS the bonding curve
      Object.assign(c, {
        marketCap: g.marketCap ?? c.marketCap, liquidity: g.liquidity ?? c.liquidity, volume: g.vol?.h24 ?? c.volume,
        change: g.chg?.h1 ?? g.chg?.h24 ?? c.change, tx: g.tx || c.tx, dex: g.dex === 'pump-fun' ? 'pumpfun' : g.dex || c.dex,
      });
      return g.mint;
    };
    const newest = (a, b) => ((coins.get(b).migratedAt || coins.get(b).createdAt || 0) - (coins.get(a).migratedAt || coins.get(a).createdAt || 0));
    const fresh = (r.new || []).map(take);
    lists.new = [...new Set([...lists.new, ...fresh])].sort(newest).slice(0, NEW_MAX);
    (r.fin || []).forEach(take);
    const mig = (r.mig || []).map((g) => {
      const m = take(g);
      const c = coins.get(m);
      c.migratedAt = c.migratedAt || g.createdAt; // the PumpSwap pool is created at graduation
      c.progress = 1;
      return m;
    });
    lists.mig = [...new Set([...lists.mig, ...mig])];
    // more graduated coins: those among DexScreener's live profiles and boosts (refreshed each minute)
    if (Date.now() - lastSeed > 60_000) {
      lastSeed = Date.now();
      try {
        const { mints } = await api('/api/pulse/seed');
        await market(mints);
        for (const m of mints) {
          const c = coins.get(m);
          if (c?.dex !== 'pumpswap') continue;
          c.migratedAt = c.migratedAt || c.createdAt; // the PumpSwap pair is created at graduation
          c.progress = 1;
          lists.mig.push(m);
        }
      } catch { /* the GeckoTerminal ones stand */ }
    }
    lists.mig = [...new Set(lists.mig)].sort(newest).slice(0, MIG_MAX);
    seeded = true;
    if (lists.new.length) saveSnapshot();
    dirty = true;
    await curves();
  }

  async function market(mints) {
    for (let i = 0; i < mints.length; i += 30) {
      const r = await api(`/api/market?mints=${mints.slice(i, i + 30).join(',')}`);
      if (r.solUsd) solUsd = r.solUsd;
      for (const [m, d] of Object.entries(r.coins || {})) {
        const c = coin(m);
        c.name = c.name || d.name;
        c.symbol = c.symbol || d.symbol;
        c.image = c.image || d.image;
        Object.assign(c, { marketCap: d.marketCap, volume: d.volume, liquidity: d.liquidity, tx: d.tx, paid: d.paid, change: d.change1h ?? d.change24h, dex: d.dex, pair: d.pair, url: d.url });
        if (d.solPair === false) c.nonSol = true;
        if (!c.createdAt && d.createdAt) c.createdAt = d.createdAt;
        if (d.dex === 'pumpfun' && d.pair && !c.curve) c.curve = d.pair; // DexScreener's pump.fun pair IS the bonding curve
        if (d.socials?.length && !c.socials.length) c.socials = d.socials;
      }
    }
    dirty = true;
  }

  async function curves() {
    const withCurve = [...coins.values()].filter((c) => c.curve && !c.migratedAt && !c.complete).slice(-100);
    if (!withCurve.length) return;
    const r = await rpc('getMultipleAccounts', [withCurve.map((c) => c.curve), { encoding: 'base64', commitment: 'confirmed' }]);
    r.value.forEach((acc, i) => {
      if (!acc?.data?.[0]) return;
      const k = readCurve(acc.data[0]);
      if (!k) return;
      const c = withCurve[i];
      c.mcapSol = k.mcapSol;
      c.progress = k.progress;
      c.complete = k.complete;
      if (!k.solQuote) c.nonSol = true;
    });
    dirty = true;
  }

  async function metas() {
    const batch = [...metaQueue].slice(0, 6);
    batch.forEach((m) => metaQueue.delete(m));
    await Promise.all(batch.map(async (m) => {
      const c = coins.get(m);
      if (!c?.uri) return;
      try {
        const { meta } = await api(`/api/meta?uri=${encodeURIComponent(c.uri)}`);
        if (!meta) return;
        c.image = c.image || meta.image;
        if (!c.socials.length) c.socials = ['twitter', 'telegram', 'website'].filter((k) => meta[k]).map((k) => ({ type: k, url: meta[k] }));
        dirty = true;
      } catch { /* no image */ }
    }));
  }

  const visibleMints = () => [...new Set([...lists.new, ...finalStretch(), ...lists.mig])];
  function finalStretch() {
    return [...coins.values()].filter((c) => c.progress >= 0.5 && c.progress < 1 && !c.complete && !c.migratedAt)
      .sort((a, b) => b.progress - a.progress).slice(0, FIN_MAX).map((c) => c.mint);
  }

  /* --------------------------------------------------------------- render */
  // on the bonding curve, the curve account itself is the truth (indexers misprice brand-new coins)
  const onCurve = (c) => c.mcapSol != null && solUsd && !c.migratedAt && !c.complete && c.dex !== 'pumpswap';
  const mcapUsd = (c) => (onCurve(c) ? c.mcapSol * solUsd : c.marketCap ?? (c.mcapSol != null && solUsd ? c.mcapSol * solUsd : null));

  function card(c) {
    let el = els.get(c.mint);
    if (!el) {
      el = document.createElement('article');
      el.className = 'pc';
      el.dataset.mint = c.mint;
      el.innerHTML = `
        <a class="pc-img" href="#/trade?m=${c.mint}" aria-label="Open coin"></a>
        <div class="pc-body">
          <div class="pc-top"><a class="pc-name" href="#/trade?m=${c.mint}"></a><span class="pc-sym"></span></div>
          <div class="pc-meta"><span class="pc-age"></span><button type="button" class="pc-ca" data-copy="${c.mint}" title="Copy contract address">${c.mint.slice(0, 4)}...${c.mint.slice(-4)} ${COPY}</button><span class="pc-soc"></span></div>
          <div class="pc-stats"><span>MC <b class="pc-mc"></b></span><span>V <b class="pc-v"></b></span><span class="pc-chg"></span></div>
          <div class="pc-prog" hidden><i><b></b></i><span></span></div>
        </div>
        <button type="button" class="pc-buy" data-qb="${c.mint}" aria-label="Quick buy">${BOLT}<span></span></button>`;
      el.dataset.fresh = '1';
      els.set(c.mint, el);
    }
    const img = el.querySelector('.pc-img');
    if (c.image && img.dataset.src !== c.image) {
      img.dataset.src = c.image;
      img.innerHTML = `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    } else if (!c.image && !img.textContent) {
      img.textContent = (c.symbol || c.name || '?').slice(0, 2).toUpperCase();
    }
    el.querySelector('.pc-name').textContent = c.name || 'Unknown';
    el.querySelector('.pc-sym').textContent = c.symbol ? `$${c.symbol}` : '';
    el.querySelector('.pc-age').textContent = age(c.migratedAt || c.createdAt);
    const mcEl = el.querySelector('.pc-mc');
    const mcText = mcapUsd(c) != null ? fmtUsd(mcapUsd(c)) : c.mcapSol != null ? `${c.mcapSol.toFixed(1)} SOL` : '-';
    if (mcEl.textContent && mcEl.textContent !== mcText && mcEl.textContent !== '-' && mcText !== '-') {
      const v = (t) => { const n = parseFloat(t.replace(/[^0-9.]/g, '')); return /B$/.test(t) ? n * 1e9 : /M$/.test(t) ? n * 1e6 : /K$/.test(t) ? n * 1e3 : n; };
      mcEl.textContent = mcText;
      roll(mcEl, v(mcText) > v(mcEl.dataset.was || mcText)); // rolls only when the value really changed
    } else mcEl.textContent = mcText;
    mcEl.dataset.was = mcText;
    el.querySelector('.pc-v').textContent = fmtUsd(c.volume);
    const chg = el.querySelector('.pc-chg');
    chg.textContent = c.change == null ? '' : `${c.change >= 0 ? '+' : ''}${Number(c.change).toFixed(1)}%`;
    chg.className = `pc-chg ${c.change > 0 ? 'up' : c.change < 0 ? 'down' : 'flat'}`; // a zero change is grey, not good news
    const soc = el.querySelector('.pc-soc');
    const socKey = c.socials.map((s) => s.url).join('|');
    if (soc.dataset.k !== socKey) {
      soc.dataset.k = socKey;
      soc.innerHTML = c.socials.filter((s) => ICON[s.type] || s.type === 'x').slice(0, 3)
        .map((s) => { const x = s.type === 'twitter' || s.type === 'x'; return `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"${x ? ` data-xprev="${esc(safeUrl(s.url))}"` : ` title="${esc(s.type)}"`}>${ICON[x ? 'twitter' : s.type]}</a>`; }).join('');
    }
    const prog = el.querySelector('.pc-prog');
    const showProg = c.progress != null && !c.migratedAt && c.dex !== 'pumpswap';
    prog.hidden = !showProg;
    if (showProg) {
      prog.querySelector("i b").style.width = `${(c.progress * 100).toFixed(1)}%`;
      prog.querySelector('span').textContent = `${(c.progress * 100).toFixed(0)}%`;
    }
    el.querySelector('.pc-buy span').textContent = ctx.quickAmount();
    return el;
  }

  function fill(id, all, empty) {
    const box = document.getElementById(id);
    const key = id.replace('p-', '');
    const mints = all.filter((m) => {
      const c = coins.get(m);
      if (c.nonSol) return false; // SOL pairs only
      const tx = c.tx?.h24 ? (c.tx.h24.buys || 0) + (c.tx.h24.sells || 0) : null;
      return passes(key, c, { mc: mcapUsd(c), liq: c.liquidity ?? null, vol: c.volume ?? null, tx, ageMin: c.createdAt ? (Date.now() - c.createdAt) / 60000 : null, progress: c.progress });
    });
    const n = activeCount(key);
    document.querySelector(`[data-filter-n="${key}"]`).textContent = n || '';
    if (n && all.length && !mints.length) empty = 'Nothing here passes this column\'s filters.';
    const want = mints.map((m) => card(coins.get(m)));
    want.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
    // a row that arrives after the column first filled pops in; the first fill opens with its panel
    const firstFill = !painted.has(id);
    want.forEach((el) => { if (el.dataset.fresh) { delete el.dataset.fresh; if (!firstFill) popRow(el); } });
    if (want.length) painted.add(id);
    while (box.children.length > want.length) box.lastElementChild.remove();
    if (!want.length) box.innerHTML = `<p class="pcol-empty">${empty}</p>`;
    else box.querySelector('.pcol-empty')?.remove();
    document.getElementById(`${id.replace('p-', 'pc-')}-n`).textContent = want.length || '';
  }

  function render() {
    if (!visible) return;
    dirty = false;
    fill('p-new', lists.new, 'Loading the latest launches...');
    fill('p-fin', finalStretch(), seeded ? 'No coin is past 50% of its bonding curve right now.' : 'Loading coins near graduation...');
    fill('p-mig', lists.mig, 'Loading graduated coins...');
  }

  /* ---------------------------------------------------------------- events */
  document.querySelector('.pulse-cols').addEventListener('click', (e) => {
    // a click anywhere on the coin (not on its own buttons or links) opens its chart
    if (!e.target.closest('a, button, input, label, [data-copy]')) {
      const hit = e.target.closest('.pc[data-mint]');
      if (hit) {
        const to = `#/trade?m=${hit.dataset.mint}`;
        if (e.ctrlKey || e.metaKey) window.open(to, '_blank');
        else location.hash = to;
        return;
      }
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      e.preventDefault();
      return copy(cp.dataset.copy, 'Contract address copied');
    }
    const qb = e.target.closest('[data-qb]');
    if (qb) {
      e.preventDefault();
      ctx.quickBuy(qb.dataset.qb, qb);
    }
    const fb = e.target.closest('[data-filter]');
    if (fb) openFilters(fb.dataset.filter);
  });
  document.getElementById('p-qb').addEventListener('input', () => { dirty = true; });

  const safe = (fn) => () => fn().catch(() => {});
  return {
    show() {
      if (visible) return;
      visible = true;
      if (!lists.new.length) restoreSnapshot();
      connect();
      safe(loadLists)();
      render();
      timers = [
        setInterval(() => { if (dirty || visible) render(); }, 1000),
        setInterval(safe(curves), 8000), // one RPC call per visitor every 8 s
        setInterval(safe(() => market(visibleMints())), 12_000),
        setInterval(safe(metas), 1500),
        setInterval(safe(loadLists), 30_000),
      ];
      ctx.onShow?.();
    },
    hide() {
      visible = false;
      timers.forEach(clearInterval);
      timers = [];
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
    },
    coin: (m) => coins.get(m),
    render,
    solUsd: () => solUsd,
  };
}
