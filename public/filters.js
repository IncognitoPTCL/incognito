// Filters for every terminal list (Discover, and each Pulse column), like a trading terminal's:
// market cap, liquidity, volume, age, transactions, bonding progress, socials, DEX paid and
// keywords. Each list keeps its own set in localStorage. One panel element edits whichever list
// opened it.
const KEY = 'incognito:filters:v1';
const BLANK = { mcMin: '', mcMax: '', liqMin: '', volMin: '', ageMin: '', ageMax: '', txMin: '', progMin: '', progMax: '', x: false, tg: false, web: false, paid: false, include: '', exclude: '' };
const NAMES = { discover: 'Discover', new: 'New pairs', fin: 'Final stretch', mig: 'Migrated' };

let all = {};
try {
  all = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
} catch { /* defaults */ }
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* session only */ }
};

export const filtersFor = (list) => ({ ...BLANK, ...(all[list] || {}) });
export function activeCount(list) {
  const f = filtersFor(list);
  return Object.keys(BLANK).filter((k) => f[k] !== BLANK[k] && f[k] !== '').length;
}

const num = (v) => (v === '' || v == null ? null : Number(v));
const has = (c, type) => (c.socials || []).some((s) => s.type === type || (type === 'twitter' && s.type === 'x'));

/**
 * Does a coin pass this list's filters? `m` gives the coin's numbers for the list's timeframe:
 * { mc, liq, vol, tx, ageMin, progress }.
 */
export function passes(list, c, m) {
  const f = filtersFor(list);
  const lo = (v, min) => min == null || (v != null && v >= min);
  const hi = (v, max) => max == null || (v != null && v <= max);
  if (!lo(m.mc, num(f.mcMin) && num(f.mcMin) * 1000) || !hi(m.mc, num(f.mcMax) && num(f.mcMax) * 1000)) return false;
  if (!lo(m.liq, num(f.liqMin) && num(f.liqMin) * 1000)) return false;
  if (!lo(m.vol, num(f.volMin) && num(f.volMin) * 1000)) return false;
  if (!lo(m.tx, num(f.txMin))) return false;
  if (!lo(m.ageMin, num(f.ageMin)) || !hi(m.ageMin, num(f.ageMax))) return false;
  if (!lo(m.progress == null ? null : m.progress * 100, num(f.progMin)) || !hi(m.progress == null ? null : m.progress * 100, num(f.progMax))) return false;
  if (f.x && !has(c, 'twitter')) return false;
  if (f.tg && !has(c, 'telegram')) return false;
  if (f.web && !has(c, 'website')) return false;
  if (f.paid && !c.paid) return false;
  const text = `${c.name || ''} ${c.symbol || ''}`.toLowerCase();
  const words = (s) => s.toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (f.include && !words(f.include).some((w) => text.includes(w))) return false;
  if (f.exclude && words(f.exclude).some((w) => text.includes(w))) return false;
  return true;
}

let panel = null;
let current = '';
let onChange = () => {};

export function initFilters(changed) {
  onChange = changed;
  panel = document.createElement('div');
  panel.className = 'overlay';
  panel.hidden = true;
  panel.innerHTML = `
    <form class="sheet fsheet" id="f-form">
      <div class="fs-head"><h3 id="f-title">Filters</h3><button type="button" class="icon-btn" data-f="close" aria-label="Close">&times;</button></div>
      <div class="fs-grid">
        <label class="field"><span>Market cap min ($K)</span><input name="mcMin" type="number" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Market cap max ($K)</span><input name="mcMax" type="number" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Liquidity min ($K)</span><input name="liqMin" type="number" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Volume min ($K)</span><input name="volMin" type="number" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Age min (minutes)</span><input name="ageMin" type="number" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Age max (minutes)</span><input name="ageMax" type="number" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Transactions min</span><input name="txMin" type="number" min="0" step="1" inputmode="numeric"></label>
        <label class="field"><span>Bonding curve % min</span><input name="progMin" type="number" min="0" max="100" step="any" inputmode="decimal"></label>
        <label class="field"><span>Bonding curve % max</span><input name="progMax" type="number" min="0" max="100" step="any" inputmode="decimal"></label>
      </div>
      <div class="fs-checks">
        <label><input type="checkbox" name="x"> Has X</label>
        <label><input type="checkbox" name="tg"> Has Telegram</label>
        <label><input type="checkbox" name="web"> Has website</label>
        <label><input type="checkbox" name="paid"> DEX paid</label>
      </div>
      <div class="fs-grid fs-2">
        <label class="field"><span>Name has any of</span><input name="include" placeholder="cat, ai" autocomplete="off"></label>
        <label class="field"><span>Hide names with</span><input name="exclude" placeholder="rug, test" autocomplete="off"></label>
      </div>
      <div class="btn-row"><button type="button" class="btn btn-ghost" data-f="reset">Reset</button><button type="submit" class="btn btn-primary">Apply</button></div>
    </form>`;
  document.body.append(panel);
  const form = panel.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = { ...BLANK };
    for (const k of Object.keys(BLANK)) {
      const el = form.elements[k];
      f[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    all[current] = f;
    save();
    panel.hidden = true;
    onChange(current);
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (e.target === panel || b?.dataset.f === 'close') panel.hidden = true;
    if (b?.dataset.f === 'reset') {
      delete all[current];
      save();
      panel.hidden = true;
      onChange(current);
    }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.hidden = true; });
}

export function openFilters(list) {
  current = list;
  const f = filtersFor(list);
  const form = panel.querySelector('form');
  for (const k of Object.keys(BLANK)) {
    const el = form.elements[k];
    if (el.type === 'checkbox') el.checked = !!f[k];
    else el.value = f[k];
  }
  panel.querySelector('#f-title').textContent = `Filters: ${NAMES[list] || list}`;
  panel.hidden = false;
  form.elements.mcMin.focus();
}

export const FILTER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
