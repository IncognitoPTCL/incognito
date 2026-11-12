import { hatSvg } from './logo.js';
import { createPulse, readCurve, fmtUsd, age } from './terminal.js';
import { startPixels } from './pixels.js';
import { startXCards } from './xcard.js';
import { createDiscover } from './discover.js';
import { initFilters } from './filters.js';
import { hostOnArweave } from './host.js';
import { safeUrl } from './safe.js';

const pixels = startPixels(document.getElementById('px'));
import {
  base58, unbase58, isAddress, toB64, fromB64, readTransaction, placeSignature, canSign,
  signerFromSeed, freshSigner, signerFromBackup, transferMessage, unsignedTransaction, signedTransaction,
} from './sol.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const sol = (lamports, dp = 4) => (lamports / 1e9).toFixed(dp).replace(/\.?0+$/, '') || '0';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// A launch with no first buy measured 0.0062 SOL on mainnet (rent for the coin's
// accounts plus fees, measured 2026-11-11). 0.008 leaves headroom; never ask for the exact figure.
const BASE_NEED = 0.008;
const BUY_OVERHEAD = 1.02; // pump.fun's trading fee on the first buy, with margin
const HEADROOM = 0.003;
const TX_FEE = 5000; // lamports, one signature

document.querySelectorAll('[data-logo]').forEach((el) => { el.innerHTML = hatSvg(); });

/* ------------------------------------------------------------------ toast */
let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 2800);
}
async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Copy failed. Select it by hand.');
  }
}

/* ---------------------------------------------------------------- storage
   The fresh wallets, keys included, live in this browser's localStorage.
   Nothing about them is sent anywhere except the public address. */
const KEY = 'incognito:wallets:v1';
let storageOk = true;
let wallets = [];
try {
  wallets = JSON.parse(localStorage.getItem(KEY) || '[]');
  if (!Array.isArray(wallets)) wallets = [];
  localStorage.setItem('incognito:probe', '1');
} catch {
  storageOk = false;
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(wallets));
    storageOk = true;
  } catch {
    storageOk = false;
  }
}
const byAddress = (a) => wallets.find((w) => w.address === a);

const signers = new Map();
async function signerOf(w) {
  if (signers.has(w.address)) return signers.get(w.address);
  const s = await signerFromSeed(unbase58(w.seed));
  if (s.address !== w.address) throw new Error('The stored key does not match its address.');
  signers.set(w.address, s);
  return s;
}

async function makeWallet(use = 'launch') {
  const s = await freshSigner();
  signers.set(s.address, s);
  const w = { address: s.address, seed: base58(s.seed), createdAt: Date.now(), backedUp: false, coin: null, use };
  wallets.push(w);
  save();
  return w;
}

async function exportKey(w, how) {
  const s = await signerOf(w);
  if (how === 'copy') {
    await copy(base58(s.secret), 'Private key copied. Paste it somewhere safe.');
  } else {
    const blob = new Blob([JSON.stringify([...s.secret])], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `incognito-${w.address.slice(0, 6)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Key file downloaded.');
  }
  if (!w.backedUp) {
    w.backedUp = true;
    save();
  }
}

/* ------------------------------------------------------------------- API */
let padKey = '';
try {
  padKey = localStorage.getItem('incognito:pad') || '';
} catch { /* none */ }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-pad-key': padKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showGate();
    throw new Error(data.error || 'Password needed.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

async function rpc(method, params) {
  const body = await api('/api/rpc', { method, params });
  if (body.error) {
    const e = new Error(body.error.message || 'Solana refused it.');
    e.rpc = body.error;
    throw e;
  }
  return body.result;
}
const balanceOf = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;
const blockhash = async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;

async function balances(addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [chunk, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    chunk.forEach((a, j) => { out[a] = r.value[j]?.lamports ?? 0; });
  }
  return out;
}

function explain(e) {
  const d = e.rpc?.data;
  const m = [e.message, JSON.stringify(d?.err ?? ''), (d?.logs || []).join(' ')].join(' ');
  if (/InsufficientFundsForRent|insufficient lamports|insufficient funds|Attempt to debit/i.test(m)) return 'Not enough SOL in the wallet for this. Nothing was sent.';
  if (/blockhash not found|expired/i.test(m)) return 'It expired before reaching the network. Nothing was sent: try again.';
  return `Solana refused it: ${e.message}`;
}

async function sendRaw(bytes) {
  try {
    return await rpc('sendTransaction', [toB64(bytes), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
  } catch (e) {
    throw new Error(e.rpc ? explain(e) : e.message);
  }
}

async function confirmSig(sig, ms = 80_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(2000);
    try {
      const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
      const s = r.value[0];
      if (s?.err) return { ok: false, err: s.err };
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { ok: true };
    } catch { /* keep polling */ }
  }
  return { ok: null };
}

/* --------------------------------------------------------- password gate */
function showGate() {
  $('gate').hidden = false;
  setTimeout(() => $('gate-pw').focus(), 50);
}
$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  padKey = $('gate-pw').value;
  $('gate-err').textContent = '';
  try {
    await api('/api/unlock', {});
    try { localStorage.setItem('incognito:pad', padKey); } catch { /* session only */ }
    $('gate').hidden = true;
    route();
  } catch (err) {
    $('gate-err').textContent = err.message;
    $('gate').hidden = false;
  }
});

/* -------------------------------------------- your main wallet (funding)
   Wallet Standard discovery: wallets announce themselves, we register them. */
const found = new Map();
const registry = {
  register: (...ws) => {
    ws.forEach((w) => {
      const f = w?.features || {};
      if (w?.name && f['standard:connect'] && (f['solana:signTransaction'] || f['solana:signAndSendTransaction'])) found.set(w.name, w);
    });
    return () => {};
  },
};
window.addEventListener('wallet-standard:register-wallet', (e) => {
  try { e.detail(registry); } catch { /* a broken wallet */ }
});
try {
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));
} catch { /* none */ }

const main = { w: null, account: null };
function paintConnect() {
  const a = main.account?.address;
  $('connect').classList.toggle('is-on', !!a);
  $('connect').textContent = a ? short(a) : 'Connect';
  document.querySelectorAll('[data-main-dest]').forEach((i) => { if (a && !i.value) i.value = a; });
}
function chooseWallet() {
  const list = [...found.values()];
  if (!list.length) return Promise.reject(new Error('No Solana wallet found. Install Phantom or Solflare and reload.'));
  if (list.length === 1) return Promise.resolve(list[0]);
  return new Promise((resolve, reject) => {
    $('picker-list').innerHTML = list.map((w, i) => `<button type="button" data-i="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}</button>`).join('');
    $('picker').hidden = false;
    $('picker-list').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('picker').hidden = true;
      resolve(list[Number(b.dataset.i)]);
    };
    $('picker-close').onclick = () => {
      $('picker').hidden = true;
      reject(new Error('No wallet chosen.'));
    };
  });
}
async function connect() {
  const w = await chooseWallet();
  const { accounts } = await w.features['standard:connect'].connect();
  if (!accounts?.[0]) throw new Error('That wallet returned no account.');
  main.w = w;
  main.account = accounts[0];
  w.features['standard:events']?.on('change', ({ accounts: next }) => {
    if (next) {
      main.account = next[0] ?? null;
      paintConnect();
    }
  });
  paintConnect();
  return main.account;
}
$('connect').addEventListener('click', async () => {
  if (main.account) {
    try { await main.w.features['standard:disconnect']?.disconnect(); } catch { /* ignore */ }
    main.w = null;
    main.account = null;
    return paintConnect();
  }
  try {
    await connect();
  } catch (e) {
    toast(e.message);
  }
});

async function fundFromMain(to, amountSol) {
  if (!main.account) await connect();
  const lamports = Math.round(amountSol * 1e9);
  if (!(lamports > 0)) throw new Error('Enter how much SOL to send.');
  const msg = transferMessage({ from: main.account.address, to, lamports, blockhash: await blockhash() });
  const unsigned = unsignedTransaction(msg);
  const f = main.w.features;
  if (f['solana:signTransaction']) {
    const [out] = await f['solana:signTransaction'].signTransaction({ account: main.account, transaction: unsigned, chain: 'solana:mainnet' });
    return sendRaw(out.signedTransaction);
  }
  const [out] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: main.account, transaction: unsigned, chain: 'solana:mainnet' });
  return base58(out.signature);
}

async function withdraw(w, to) {
  if (!isAddress(to)) throw new Error('That is not a Solana address.');
  if (to === w.address) throw new Error('That is this same wallet.');
  const s = await signerOf(w);
  const lamports = (await balanceOf(w.address)) - TX_FEE;
  if (lamports <= 0) throw new Error('Nothing to withdraw.');
  const msg = transferMessage({ from: w.address, to, lamports, blockhash: await blockhash() });
  const id = await sendRaw(signedTransaction(msg, await s.sign(msg)));
  return { id, lamports };
}

async function claimFees(w) {
  const s = await signerOf(w);
  const { tx } = await api('/api/claim', { publicKey: w.address });
  const raw = fromB64(tx);
  const t = readTransaction(raw);
  if (t.signers.length !== 1 || t.signers[0] !== w.address) throw new Error('That claim was not built for this wallet. Nothing was signed.');
  return sendRaw(placeSignature(raw, w.address, await s.sign(t.message)));
}

/* ------------------------------------------------------------- coin form */
const form = { image: null };
const val = (id) => $(id).value.trim();
const buySol = () => Math.max(0, Number($('buy').value) || 0);
const need = () => BASE_NEED + buySol() * BUY_OVERHEAD;
const suggest = () => Math.ceil((need() + HEADROOM) * 1000) / 1000;
function formProblem() {
  if (!form.image) return 'Add an image.';
  if (!val('name')) return 'Name the coin.';
  if (!/^[A-Z0-9]{1,10}$/.test(val('symbol'))) return 'Add a ticker (letters and digits).';
  return '';
}

$('image').addEventListener('change', () => {
  const file = $('image').files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Use a PNG, JPG, GIF or WebP.');
  if (file.size > 3 * 1024 * 1024) return toast('Use an image under 3 MB.');
  const r = new FileReader();
  r.onload = () => {
    form.image = r.result;
    $('image-preview').src = r.result;
    $('image-preview').hidden = false;
    $('drop-hint').hidden = true;
    updateReady();
  };
  r.readAsDataURL(file);
});
['dragenter', 'dragover'].forEach((t) => $('drop').addEventListener(t, () => $('drop').classList.add('is-over')));
['dragleave', 'drop'].forEach((t) => $('drop').addEventListener(t, () => $('drop').classList.remove('is-over')));
$('symbol').addEventListener('input', () => {
  const v = $('symbol').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v !== $('symbol').value) $('symbol').value = v;
});
['name', 'symbol', 'buy'].forEach((id) => $(id).addEventListener('input', updateReady));
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('buy').value = b.dataset.v;
  updateReady();
});

/* ------------------------------------------------------ deployer panel */
const st = { launching: false, balance: null, log: [], justLaunched: null, poll: null, signOk: true, canHost: true, serverHost: false };
const draft = () => [...wallets].reverse().find((w) => !w.coin && w.use !== 'trade' && !w.traded);

function logHtml() {
  return st.log.length ? `<ul class="log">${st.log.map((l) => `<li class="${l.cls}">${l.html}</li>`).join('')}</ul>` : '';
}
function log(html, cls = 'run') {
  st.log.forEach((l) => { if (l.cls === 'run') l.cls = 'done'; });
  st.log.push({ html, cls });
  const el = $('dep-log');
  if (el) el.innerHTML = logHtml();
}
function failLog(msg) {
  st.log.forEach((l) => { if (l.cls === 'run') l.cls = 'fail'; });
  st.log.push({ html: esc(msg), cls: 'fail' });
  const el = $('dep-log');
  if (el) el.innerHTML = logHtml();
}

const COPY_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const addrRow = (a, label = 'Copy address') => `<div class="addr"><code>${esc(a)}</code><button type="button" class="icon-btn" data-copy="${esc(a)}" aria-label="${label}">${COPY_ICON}</button></div>`;

function renderDep() {
  const dep = $('dep');
  if (!st.signOk) {
    dep.innerHTML = '<div class="notice">This browser cannot make Solana keys. Use a current Chrome, Brave, Edge, Firefox or Safari.</div>';
    return;
  }
  const done = st.justLaunched && byAddress(st.justLaunched);
  if (done) return renderDone(done);
  const w = draft();
  const storageNote = storageOk ? '' : '<div class="notice"><b>This browser is not saving keys</b> (private window or blocked storage). Download the key before you fund it, or it is gone when you close the tab.</div>';

  if (!st.canHost && !w?.coin) {
    dep.innerHTML = '<div class="notice"><b>Launching is paused.</b> The pad has nowhere to host coin images yet: pump.fun blocks uploads from servers, so it needs an IPFS key (PINATA_JWT). Trading works now: open the Terminal.</div><a class="btn btn-primary btn-block" href="#/discover">Open terminal</a>';
    return;
  }
  if (!w) {
    dep.innerHTML = `
      <p class="dep-intro">Your coin deploys from a brand-new wallet made right here. It has no history. The only on-chain link to you is wherever its SOL comes from.</p>
      ${storageNote}
      <button type="button" class="btn btn-primary btn-block" data-act="make">Make a fresh wallet</button>`;
    return;
  }
  if (!w.backedUp) {
    dep.innerHTML = `
      ${addrRow(w.address)}
      <div class="notice"><b>Save the key first.</b> This wallet exists only in this browser. If you clear it without a backup, anything sent to it is lost.</div>
      ${storageNote}
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-act="key-file">Download key file</button>
        <button type="button" class="btn btn-ghost" data-act="key-copy">Copy private key</button>
      </div>`;
    return;
  }
  dep.innerHTML = `
    ${addrRow(w.address)}
    <div class="stats">
      <div class="stat" id="bal-stat"><b id="bal">...</b><span>In the wallet</span></div>
      <div class="stat"><b id="need">${sol(need() * 1e9)} SOL</b><span>Needed to launch</span></div>
    </div>
    <div id="fund-box">
      <div class="notice calm">Send at least <b id="suggest">${suggest()} SOL</b> to the address above, from any wallet or exchange. It shows up here on its own.</div>
      <div class="fund">
        <input id="fund-amt" type="number" min="0" step="0.001" value="${suggest()}" inputmode="decimal" aria-label="SOL to send">
        <button type="button" class="btn btn-ghost" data-act="fund">Send from my wallet</button>
      </div>
    </div>
    <div class="sep"></div>
    <button type="button" class="btn btn-primary btn-block" id="go" data-act="launch">Launch on pump.fun</button>
    <small id="go-why"></small>
    <small class="fee-note">Creating the coin costs about 0.006 to 0.008 SOL, plus your first buy and its fees. Incognito takes none. The image and details go to Arweave, which is public and permanent. <a href="/legal.html#risk" target="_blank" rel="noopener">Risks</a></small>
    <div id="dep-log">${logHtml()}</div>
    <div class="sep"></div>
    <div class="btn-row">
      <button type="button" class="btn btn-ghost btn-sm" data-act="key-copy">Copy key again</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="make">Use another fresh wallet</button>
    </div>`;
  paintBalance();
  updateReady();
}

function paintBalance() {
  const el = $('bal');
  if (!el) return;
  el.textContent = st.balance === null ? '...' : `${sol(st.balance)} SOL`;
  const enough = st.balance !== null && st.balance >= need() * 1e9;
  $('bal-stat').classList.toggle('ok', enough);
  $('fund-box').hidden = enough && !st.launching;
}

function updateReady() {
  if ($('need')) $('need').textContent = `${sol(need() * 1e9)} SOL`;
  if ($('suggest')) $('suggest').textContent = `${suggest()} SOL`;
  const go = $('go');
  if (!go) return;
  const problem = formProblem();
  const short_ = st.balance === null ? 'Checking the balance...' : st.balance < need() * 1e9 ? 'Fund the wallet to launch.' : '';
  go.disabled = st.launching || !!problem || !!short_;
  $('go-why').textContent = st.launching ? '' : problem || short_;
  paintBalance();
}

async function pollBalance() {
  const w = draft();
  if (!w || !w.backedUp || document.hidden) return;
  try {
    st.balance = await balanceOf(w.address);
    st.balanceFor = w.address;
    updateReady();
  } catch { /* next tick */ }
}
function startPoll() {
  stopPoll();
  pollBalance();
  st.poll = setInterval(pollBalance, 4000);
}
function stopPoll() {
  clearInterval(st.poll);
  st.poll = null;
}

async function launch() {
  const w = draft();
  if (!w || st.launching) return;
  const problem = formProblem();
  if (problem) return toast(problem);
  st.launching = true;
  st.log = [];
  updateReady();
  const name = val('name');
  const symbol = val('symbol');
  try {
    const deployer = await signerOf(w);
    const bal = await balanceOf(w.address);
    if (bal < need() * 1e9) throw new Error(`The wallet holds ${sol(bal)} SOL. Launching needs about ${sol(need() * 1e9)} SOL.`);

    log('Uploading the image and metadata');
    const fields = { name, symbol, description: val('description'), twitter: val('twitter'), telegram: val('telegram'), website: val('website'), image: form.image };
    const meta = st.serverHost ? await api('/api/metadata', fields) : await hostOnArweave(fields);
    log(`Metadata hosted (${esc(meta.via)}). Building the launch`);
    const mint = await freshSigner();
    const { tx } = await api('/api/create', { publicKey: w.address, mint: mint.address, name, symbol, uri: meta.uri, buySol: buySol() });

    const raw = fromB64(tx);
    const t = readTransaction(raw);
    if (t.signers.length !== 2 || t.signers[0] !== w.address || !t.signers.includes(mint.address) || !t.accounts.includes(PUMP_PROGRAM)) {
      throw new Error('The launch transaction was not the one asked for. Nothing was signed.');
    }
    log('Signing with the fresh wallet and the new mint');
    let signed = placeSignature(raw, mint.address, await mint.sign(t.message));
    signed = placeSignature(signed, w.address, await deployer.sign(t.message));

    log('Sending to Solana');
    const sig = await sendRaw(signed);
    // Record it before waiting, so a reload can never offer to launch from this wallet twice.
    w.coin = { mint: mint.address, name, symbol, image: meta.image || '', uri: meta.uri, sig, status: 'sent', at: Date.now(), buySol: buySol() };
    save();
    log(`Sent. Waiting for confirmation (<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">transaction</a>)`);
    const c = await confirmSig(sig);
    if (c.ok === false) {
      w.coin.status = 'failed';
      save();
      throw new Error(`The launch failed on chain: ${JSON.stringify(c.err)}`);
    }
    w.coin.status = c.ok ? 'live' : 'sent';
    save();
    log(c.ok ? 'Live on pump.fun' : 'Sent but not confirmed yet. Do not launch it again; check the transaction.', c.ok ? 'done' : 'run');
    st.justLaunched = w.address;
    st.launching = false;
    renderDep();
  } catch (e) {
    st.launching = false;
    failLog(e.message);
    // a failed on-chain launch frees the wallet for another try
    if (w.coin?.status === 'failed') {
      w.coin = null;
      save();
    }
    updateReady();
  }
}

function renderDone(w) {
  const c = w.coin;
  const pump = `https://pump.fun/coin/${c.mint}`;
  $('dep').innerHTML = `
    <div class="done-card">
      ${c.image ? `<img src="${esc(c.image)}" alt="">` : ''}
      <div><h4>${esc(c.name)} <span class="ok-text">$${esc(c.symbol)}</span></h4><p>${c.status === 'live' ? 'Live on pump.fun' : 'Sent, confirming'} from ${esc(short(w.address))}</p></div>
    </div>
    ${addrRow(c.mint, 'Copy contract address')}
    <div class="btn-row" style="margin-top:12px">
      <a class="btn btn-primary" href="${pump}" target="_blank" rel="noopener">Open on pump.fun</a>
      <a class="btn btn-ghost" href="https://solscan.io/tx/${esc(c.sig)}" target="_blank" rel="noopener">Transaction</a>
    </div>
    <div id="dep-log">${logHtml()}</div>
    <div class="sep"></div>
    <h3 style="margin:0 0 8px;font-size:14px">Send leftover SOL back</h3>
    <p class="dep-intro" style="margin-bottom:10px">Creator fees from trading collect to this fresh wallet. Claim them later from Wallets (keep about 0.001 SOL in it, or send some back first).</p>
    <div class="fund">
      <input id="wd-to" data-main-dest placeholder="Your wallet address" value="${esc(main.account?.address || '')}" autocomplete="off" spellcheck="false">
      <button type="button" class="btn btn-ghost" data-act="withdraw-done">Withdraw all</button>
    </div>
    <div class="sep"></div>
    <button type="button" class="btn btn-primary btn-block" data-act="another">Launch another coin</button>`;
}

$('dep').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act],[data-copy]');
  if (!b) return;
  if (b.dataset.copy) return copy(b.dataset.copy, 'Address copied');
  const act = b.dataset.act;
  try {
    if (act === 'make') {
      b.disabled = true;
      await makeWallet();
      st.balance = null;
      st.log = [];
      renderDep();
      startPoll();
    } else if (act === 'key-file' || act === 'key-copy') {
      await exportKey(draft(), act === 'key-file' ? 'file' : 'copy');
      if (act === 'key-file' || $('dep').querySelector('[data-act="key-file"]')) {
        renderDep();
        startPoll();
      }
    } else if (act === 'fund') {
      b.disabled = true;
      const sig = await fundFromMain(draft().address, Number($('fund-amt').value));
      toast('Sent. The balance updates in a few seconds.');
      confirmSig(sig, 40_000).then(pollBalance);
    } else if (act === 'launch') {
      await launch();
    } else if (act === 'withdraw-done') {
      b.disabled = true;
      const { lamports } = await withdraw(byAddress(st.justLaunched), $('wd-to').value.trim());
      toast(`Withdrew ${sol(lamports)} SOL.`);
    } else if (act === 'another') {
      st.justLaunched = null;
      st.log = [];
      st.balance = null;
      ['name', 'symbol', 'description', 'twitter', 'telegram', 'website'].forEach((id) => { $(id).value = ''; });
      $('buy').value = '0';
      form.image = null;
      $('image').value = '';
      $('image-preview').hidden = true;
      $('drop-hint').hidden = false;
      renderDep();
      startPoll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  } catch (err) {
    toast(err.message);
  } finally {
    if (b.isConnected) b.disabled = false;
    if (act === 'launch' || act === 'fund') updateReady();
  }
});

/* ---------------------------------------------------------------- wallets */
const wst = { bal: {}, open: null, forget: null };

async function refreshBalances() {
  if (!wallets.length) return;
  try {
    wst.bal = await balances(wallets.map((w) => w.address));
  } catch (e) {
    toast(e.message);
  }
  renderWallets();
}

function renderWallets() {
  const list = $('wlist');
  if (!wallets.length) {
    list.innerHTML = '<div class="empty">No fresh wallets yet.<br><a class="btn btn-primary" href="#/launch">Launch a coin</a></div>';
    return;
  }
  list.innerHTML = [...wallets].reverse().map((w) => {
    const c = w.coin;
    const lam = wst.bal[w.address];
    const open = wst.open?.address === w.address ? wst.open.kind : '';
    let more = '';
    if (open === 'withdraw') {
      more = `<div class="w-more"><input data-main-dest data-wd="${w.address}" placeholder="Send everything to this address" value="${esc(main.account?.address || '')}" autocomplete="off" spellcheck="false"><button type="button" class="btn btn-primary btn-sm" data-act="wd-go" data-a="${w.address}">Withdraw all SOL</button><p>Tokens stay in the wallet. Sell them from Trade first.</p></div>`;
    } else if (open === 'key') {
      more = `<div class="w-more"><button type="button" class="btn btn-ghost btn-sm" data-act="key-copy" data-a="${w.address}">Copy private key</button><button type="button" class="btn btn-ghost btn-sm" data-act="key-file" data-a="${w.address}">Download key file</button><p>To use it in Phantom: Add account, then Import private key, and paste it.</p></div>`;
    } else if (open === 'forget') {
      more = `<div class="w-more"><p>This deletes the key from this browser. Anything still in the wallet (SOL, tokens, creator fees) is then only reachable with your backup.</p><button type="button" class="btn btn-ghost btn-sm" data-act="close" data-a="${w.address}">Keep it</button><button type="button" class="btn btn-primary btn-sm" data-act="forget-go" data-a="${w.address}">Delete key</button></div>`;
    }
    const status = c ? (c.status === 'live' ? 'Live' : c.status === 'sent' ? 'Confirming' : esc(c.status)) : 'Unused';
    return `<div class="w">
      ${c?.image ? `<img class="w-img" src="${esc(c.image)}" alt="">` : '<span class="w-img">new</span>'}
      <div class="w-main"><b>${c ? `${esc(c.name)} <span class="ok-text">$${esc(c.symbol)}</span>` : 'Fresh wallet'}</b><code data-copy="${w.address}" title="Copy address">${short(w.address)}</code>${w.backedUp ? '' : ' <span class="bad" style="font-size:12px">not backed up</span>'}</div>
      <div class="w-bal"><b>${lam === undefined ? '...' : `${sol(lam)} SOL`}</b><span>${status} · ${new Date(w.createdAt).toLocaleDateString()}</span></div>
      <div class="w-act">
        ${c ? `<a class="btn btn-ghost" href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener">pump.fun</a><button type="button" class="btn btn-ghost" data-act="claim" data-a="${w.address}">Claim fees</button>` : ''}
        <a class="btn btn-ghost" href="#/trade?w=${w.address}${c ? `&m=${esc(c.mint)}` : ''}">Trade</a>
        <button type="button" class="btn btn-ghost" data-act="withdraw" data-a="${w.address}">Withdraw</button>
        <button type="button" class="btn btn-ghost" data-act="key" data-a="${w.address}">Key</button>
        <button type="button" class="btn btn-ghost" data-act="forget" data-a="${w.address}" aria-label="Delete key">Delete</button>
      </div>
      ${more}
    </div>`;
  }).join('');
}

$('wlist').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act],[data-copy]');
  if (!b) return;
  if (b.dataset.copy) return copy(b.dataset.copy, 'Address copied');
  const w = byAddress(b.dataset.a);
  const act = b.dataset.act;
  if (!w) return;
  try {
    if (['withdraw', 'key', 'forget'].includes(act)) {
      wst.open = wst.open?.address === w.address && wst.open.kind === act ? null : { address: w.address, kind: act };
      return renderWallets();
    }
    if (act === 'close') {
      wst.open = null;
      return renderWallets();
    }
    b.disabled = true;
    if (act === 'key-copy' || act === 'key-file') {
      await exportKey(w, act === 'key-file' ? 'file' : 'copy');
    } else if (act === 'wd-go') {
      const to = $('wlist').querySelector(`[data-wd="${w.address}"]`).value.trim();
      const { id, lamports } = await withdraw(w, to);
      toast(`Withdrew ${sol(lamports)} SOL.`);
      wst.open = null;
      confirmSig(id, 40_000).then(refreshBalances);
    } else if (act === 'claim') {
      if ((wst.bal[w.address] ?? 0) < 100_000) throw new Error('Send about 0.001 SOL to this wallet first to pay for the claim.');
      const id = await claimFees(w);
      toast('Claim sent.');
      confirmSig(id, 40_000).then(refreshBalances);
    } else if (act === 'forget-go') {
      wallets = wallets.filter((x) => x.address !== w.address);
      signers.delete(w.address);
      save();
      wst.open = null;
      toast('Key deleted from this browser.');
    }
    renderWallets();
  } catch (err) {
    toast(err.message);
  } finally {
    if (b.isConnected) b.disabled = false;
  }
});

$('refresh-btn').addEventListener('click', refreshBalances);
$('import-btn').addEventListener('click', () => {
  $('import').hidden = !$('import').hidden;
  if (!$('import').hidden) $('import-key').focus();
});
$('import').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const s = await signerFromBackup($('import-key').value);
    if (byAddress(s.address)) throw new Error('That wallet is already here.');
    signers.set(s.address, s);
    wallets.push({ address: s.address, seed: base58(s.seed), createdAt: Date.now(), backedUp: true, coin: null, imported: true });
    save();
    $('import-key').value = '';
    $('import').hidden = true;
    toast('Wallet added.');
    refreshBalances();
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------------------------------------------ trade
   Buy and sell any pump.fun coin from a fresh wallet. PumpPortal builds the
   transaction (pool 'auto' covers graduated coins), the fresh key signs here. */
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const TRADE_RESERVE = 0.003; // fees plus rent for the coin's token account on a first buy
const tst = { mint: '', coin: null, coinFor: '', wallet: '', sol: null, tokens: null, busy: false, log: [], poll: null };

function tradeWallet() {
  return byAddress(tst.wallet) || [...wallets].reverse().find((w) => w.use === 'trade') || null;
}

async function tokenBalance(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return r.value.reduce((sum, a) => sum + (Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount) || 0), 0);
}

function tlog(html, cls = 'run') {
  tst.log.forEach((l) => { if (l.cls === 'run') l.cls = 'done'; });
  tst.log.push({ html, cls });
  const el = $('t-log');
  if (el) el.innerHTML = tst.log.length ? `<ul class="log">${tst.log.map((l) => `<li class="${l.cls}">${l.html}</li>`).join('')}</ul>` : '';
}

const pct = (v) => (v == null ? '' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%</span>`);

function renderCoin() {
  const bar = $('t-coin');
  const chart = $('t-chart');
  if (!tst.mint) {
    bar.innerHTML = '<p class="coin-empty">Paste a contract address in the search bar, or pick a coin from the Terminal.</p>';
    chart.innerHTML = '';
    return;
  }
  const c = tst.coin || {};
  const p = pulse.coin(tst.mint) || {};
  const name = c.name || p.name || 'Unknown coin';
  const symbol = c.symbol || p.symbol || '';
  const image = c.image || p.image;
  const mc = c.marketCap ?? (tst.curve?.mcapSol != null && pulse.solUsd() ? tst.curve.mcapSol * pulse.solUsd() : null);
  const prog = tst.curve && !tst.curve.complete && c.dex !== 'pumpswap' && tst.curve.solQuote !== false ? tst.curve.progress : null;
  const nonSol = c.solPair === false || tst.curve?.solQuote === false;
  bar.innerHTML = `
    <div class="cb-id">
      ${image ? `<img src="${esc(image)}" alt="" referrerpolicy="no-referrer">` : `<span class="cb-ph">${esc((symbol || name).slice(0, 2).toUpperCase())}</span>`}
      <div><h2>${esc(name)} <span>${symbol ? `$${esc(symbol)}` : ''}</span></h2>
      <button type="button" class="pc-ca" data-copy="${tst.mint}">${short(tst.mint)} <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button></div>
    </div>
    <dl class="cb-stats">
      <div><dt>Market cap</dt><dd>${fmtUsd(mc)}</dd></div>
      <div><dt>Price</dt><dd>${c.priceUsd ? `$${c.priceUsd < 0.0001 ? c.priceUsd.toExponential(2) : c.priceUsd.toPrecision(3)}` : '-'}</dd></div>
      <div><dt>Liquidity</dt><dd>${fmtUsd(c.liquidity)}</dd></div>
      <div><dt>24h volume</dt><dd>${fmtUsd(c.volume)}</dd></div>
      <div><dt>5m</dt><dd>${pct(c.change5m) || '-'}</dd></div>
      <div><dt>1h</dt><dd>${pct(c.change1h) || '-'}</dd></div>
      <div><dt>24h</dt><dd>${pct(c.change24h) || '-'}</dd></div>
      ${prog != null ? `<div class="cb-prog"><dt>Bonding curve</dt><dd><i><b style="width:${(prog * 100).toFixed(1)}%"></b></i>${(prog * 100).toFixed(0)}%</dd></div>` : ''}
    </dl>
    ${nonSol ? `<span class="chip" style="color:var(--warn)">Priced in ${c.quote ? `$${esc(c.quote)}` : 'another token'}, not SOL: not tradable here</span>` : ''}
    <div class="cb-links">
      <a href="https://pump.fun/coin/${esc(tst.mint)}" target="_blank" rel="noopener">pump.fun</a>
      ${c.url ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer">DexScreener</a>` : ''}
      <a href="https://solscan.io/token/${esc(tst.mint)}" target="_blank" rel="noopener">Solscan</a>
      ${(c.socials || p.socials || []).slice(0, 3).map((s) => { const x = s.type === 'twitter' || s.type === 'x'; return `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"${x ? ` data-xprev="${esc(safeUrl(s.url))}"` : ''}>${x ? 'X' : s.type === 'telegram' ? 'Telegram' : 'Website'}</a>`; }).join('')}
    </div>`;
  const target = c.pair || null;
  if (target && chart.dataset.for !== target) {
    chart.dataset.for = target;
    chart.innerHTML = `<iframe title="Chart and trades" src="https://dexscreener.com/solana/${esc(target)}?embed=1&loadChartSettings=0&trades=1&tabs=1&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=1" referrerpolicy="no-referrer"></iframe>`;
  } else if (!target && chart.dataset.for !== 'none') {
    chart.dataset.for = 'none';
    chart.innerHTML = '<div class="chart-wait"><p>The chart appears once DexScreener indexes this coin\'s first trades.</p><small>Trading works already.</small></div>';
  }
}

async function refreshCoin() {
  const m = tst.mint;
  if (!m) return;
  try {
    const r = await api(`/api/market?mints=${m}`);
    if (m !== tst.mint) return;
    tst.coin = r.coins?.[m] || tst.coin;
    const curveAddr = tst.coin?.dex === 'pumpfun' ? tst.coin.pair : pulse.coin(m)?.curve;
    if (curveAddr) {
      const acc = await rpc('getAccountInfo', [curveAddr, { encoding: 'base64', commitment: 'confirmed' }]);
      if (acc.value?.data?.[0]) tst.curve = readCurve(acc.value.data[0]);
    }
  } catch { /* details are optional */ }
  if (m === tst.mint) renderCoin();
}

async function loadCoin(m) {
  if (m === tst.mint && tst.coin) return refreshCoin();
  tst.mint = isAddress(m) ? m : '';
  tst.coin = null;
  tst.curve = null;
  tst.tokens = null;
  tst.log = [];
  renderCoin();
  renderTradeWallet();
  await refreshCoin();
  pollTrade();
}
$('t-coin').addEventListener('click', (e) => {
  const cp = e.target.closest('[data-copy]');
  if (cp) copy(cp.dataset.copy, 'Contract address copied');
});

function renderTradeWallet() {
  const box = $('t-wallet');
  if (!st.signOk) {
    box.innerHTML = '<div class="notice">This browser cannot make Solana keys. Use a current Chrome, Brave, Edge, Firefox or Safari.</div>';
    return;
  }
  const w = tradeWallet();
  if (!w) {
    box.innerHTML = `<p class="dep-intro">Trades run from a brand-new wallet made right here, so your main wallet never appears on the chart. The only on-chain link to you is wherever its SOL comes from.</p>
      <button type="button" class="btn btn-primary btn-block" data-tact="make">Make a fresh wallet</button>`;
    return;
  }
  if (!w.backedUp) {
    box.innerHTML = `${addrRow(w.address)}
      <div class="notice"><b>Save the key first.</b> This wallet exists only in this browser.</div>
      <div class="btn-row"><button type="button" class="btn btn-primary" data-tact="key-file">Download key file</button><button type="button" class="btn btn-ghost" data-tact="key-copy">Copy private key</button></div>`;
    return;
  }
  const opts = [...wallets].reverse().filter((x) => x.backedUp)
    .map((x) => `<option value="${x.address}"${x.address === w.address ? ' selected' : ''}>${short(x.address)}${x.coin ? ` (deployed $${esc(x.coin.symbol)})` : ''}</option>`).join('');
  const sym = tst.coin?.symbol ? `$${esc(tst.coin.symbol)}` : 'tokens';
  box.innerHTML = `
    <div class="fund" style="margin-top:0">
      <select id="t-w" aria-label="Trading wallet">${opts}</select>
      <button type="button" class="btn btn-ghost" data-tact="make">New fresh wallet</button>
    </div>
    <div style="margin-top:10px">${addrRow(w.address)}</div>
    <div class="stats">
      <div class="stat"><b id="t-sol">${tst.sol === null ? '...' : `${sol(tst.sol)} SOL`}</b><span>In the wallet</span></div>
      <div class="stat"><b id="t-tok">${!tst.mint ? '-' : tst.tokens === null ? '...' : tst.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b><span>${sym} held</span></div>
    </div>
    <div id="t-fund" ${tst.sol !== null && tst.sol >= 0.02e9 ? 'hidden' : ''}>
      <div class="notice calm">Send SOL to the address above from any wallet or exchange, or:</div>
      <div class="fund">
        <input id="t-fund-amt" type="number" min="0" step="0.01" value="0.1" inputmode="decimal" aria-label="SOL to send">
        <button type="button" class="btn btn-ghost" data-tact="fund">Send from my wallet</button>
      </div>
    </div>
    <div class="sep"></div>
    <div class="field">
      <span>Buy</span>
      <div class="buy">
        <input id="t-buy" type="number" min="0" step="0.01" value="0.1" inputmode="decimal" aria-label="SOL to spend"><em>SOL</em>
        <div class="chips" id="t-buy-chips"><button type="button" data-v="0.1">0.1</button><button type="button" data-v="0.5">0.5</button><button type="button" data-v="1">1</button></div>
      </div>
    </div>
    <button type="button" class="btn btn-primary btn-block" data-tact="buy" ${tst.mint && !tst.busy ? '' : 'disabled'}>Buy</button>
    <small class="fee-note">Fees: pump.fun\'s trading fee, 0.5% to PumpPortal (which builds the trade) and Solana network fees. Incognito takes none. <a href="/legal.html#risk" target="_blank" rel="noopener">Risks</a></small>
    <div class="field" style="margin:16px 0 8px"><span>Sell</span></div>
    <div class="btn-row">
      <button type="button" class="btn btn-ghost" data-tact="sell" data-pct="25%" ${tst.mint && tst.tokens && !tst.busy ? '' : 'disabled'}>25%</button>
      <button type="button" class="btn btn-ghost" data-tact="sell" data-pct="50%" ${tst.mint && tst.tokens && !tst.busy ? '' : 'disabled'}>50%</button>
      <button type="button" class="btn btn-ghost" data-tact="sell" data-pct="100%" ${tst.mint && tst.tokens && !tst.busy ? '' : 'disabled'}>Sell all</button>
    </div>
    <div id="t-log"></div>
    <div class="sep"></div>
    <div class="fund">
      <input id="t-wd" data-main-dest placeholder="Your wallet address" value="${esc(main.account?.address || '')}" autocomplete="off" spellcheck="false">
      <button type="button" class="btn btn-ghost" data-tact="withdraw">Withdraw SOL</button>
    </div>`;
  if (tst.log.length) $('t-log').innerHTML = `<ul class="log">${tst.log.map((l) => `<li class="${l.cls}">${l.html}</li>`).join('')}</ul>`;
}

async function pollTrade() {
  const w = tradeWallet();
  if (!w || !w.backedUp || document.hidden) return;
  try {
    tst.sol = await balanceOf(w.address);
    if (tst.mint) tst.tokens = await tokenBalance(w.address, tst.mint);
  } catch { return; }
  if ($('t-sol')) $('t-sol').textContent = `${sol(tst.sol)} SOL`;
  if ($('t-tok')) $('t-tok').textContent = !tst.mint ? '-' : tst.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if ($('t-fund')) $('t-fund').hidden = tst.sol >= 0.02e9;
  $('t-wallet').querySelectorAll('[data-tact="sell"]').forEach((b) => { b.disabled = !tst.mint || !tst.tokens || tst.busy; });
}
function startTradePoll() {
  stopTradePoll();
  pollTrade();
  tst.poll = setInterval(pollTrade, 4000);
}
function stopTradePoll() {
  clearInterval(tst.poll);
  tst.poll = null;
}

async function trade(w, action, amount, mint = tst.mint) {
  if (mint === tst.mint && (tst.coin?.solPair === false || tst.curve?.solQuote === false)) {
    throw new Error(`This coin is priced in ${tst.coin?.quote ? `$${tst.coin.quote}` : 'another token'}, not SOL. Incognito trades SOL pairs only. Nothing was signed.`);
  }
  const s = await signerOf(w);
  if (action === 'buy') {
    const bal = await balanceOf(w.address);
    if (bal < (amount * 1.02 + TRADE_RESERVE) * 1e9) throw new Error(`The wallet holds ${sol(bal)} SOL. Buying ${amount} SOL needs about ${(amount * 1.02 + TRADE_RESERVE).toFixed(3)} SOL with fees.`);
  }
  tlog(`${action === 'buy' ? `Buying with ${esc(amount)} SOL` : `Selling ${esc(amount)}`}`);
  const { tx } = await api('/api/trade', { publicKey: w.address, action, mint, amount });
  const raw = fromB64(tx);
  const t = readTransaction(raw);
  if (t.signers.length !== 1 || t.signers[0] !== w.address || !(t.accounts.includes(PUMP_PROGRAM) || t.accounts.includes(PUMP_AMM))) {
    throw new Error('That trade was not built for this wallet and pump.fun. Nothing was signed.');
  }
  const sig = await sendRaw(placeSignature(raw, w.address, await s.sign(t.message)));
  tlog(`Sent. Confirming (<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">transaction</a>)`);
  const c = await confirmSig(sig, 60_000);
  if (c.ok === false) throw new Error(`The trade failed on chain: ${JSON.stringify(c.err)}`);
  if (!w.traded) { w.traded = true; save(); }
  tlog(c.ok ? `${action === 'buy' ? 'Bought' : 'Sold'}. <a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">Transaction</a>` : 'Sent, not confirmed yet. Check the transaction before trading again.', c.ok ? 'done' : 'run');
  return sig;
}

$('t-wallet').addEventListener('change', (e) => {
  if (e.target.id !== 't-w') return;
  tst.wallet = e.target.value;
  tst.sol = null;
  tst.tokens = null;
  tst.log = [];
  renderTradeWallet();
  pollTrade();
});
$('t-wallet').addEventListener('click', async (e) => {
  const chip = e.target.closest('#t-buy-chips button');
  if (chip) {
    $('t-buy').value = chip.dataset.v;
    return;
  }
  const b = e.target.closest('[data-tact],[data-copy]');
  if (!b) return;
  if (b.dataset.copy) return copy(b.dataset.copy, 'Address copied');
  const act = b.dataset.tact;
  const w = tradeWallet();
  try {
    if (act === 'make') {
      b.disabled = true;
      const nw = await makeWallet('trade');
      tst.wallet = nw.address;
      tst.sol = null;
      tst.tokens = null;
      tst.log = [];
      renderTradeWallet();
      return;
    }
    if (act === 'key-file' || act === 'key-copy') {
      await exportKey(w, act === 'key-file' ? 'file' : 'copy');
      renderTradeWallet();
      startTradePoll();
      return;
    }
    b.disabled = true;
    if (act === 'fund') {
      const sig = await fundFromMain(w.address, Number($('t-fund-amt').value));
      toast('Sent. The balance updates in a few seconds.');
      confirmSig(sig, 40_000).then(pollTrade);
    } else if (act === 'buy' || act === 'sell') {
      if (!tst.mint) throw new Error('Paste a coin address first.');
      tst.busy = true;
      $('t-wallet').querySelectorAll('[data-tact="buy"],[data-tact="sell"]').forEach((x) => { x.disabled = true; });
      try {
        await trade(w, act, act === 'buy' ? Number($('t-buy').value) : b.dataset.pct);
      } catch (err) {
        tst.log.forEach((l) => { if (l.cls === 'run') l.cls = 'fail'; });
        tlog(esc(err.message), 'fail');
      } finally {
        tst.busy = false;
        $('t-wallet').querySelectorAll('[data-tact="buy"]').forEach((x) => { x.disabled = !tst.mint; });
        await pollTrade();
      }
    } else if (act === 'withdraw') {
      const { lamports, id } = await withdraw(w, $('t-wd').value.trim());
      toast(`Withdrew ${sol(lamports)} SOL.`);
      confirmSig(id, 40_000).then(pollTrade);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    if (b.isConnected && act !== 'buy' && act !== 'sell') b.disabled = false;
  }
});

/* --------------------------------------------------------------- terminal */
const quickAmount = () => {
  const v = Number($('p-qb').value);
  return v > 0 ? String(v) : '0';
};
/* Quick buy. With a funded trading wallet it buys at once. Otherwise a sheet opens right there and
   walks through making the fresh wallet, saving its key and funding it, then buys. */
const qbs = { mint: '', amount: 0, bal: null, busy: false, done: '', err: '', poll: 0 };
const buyNeed = (amount) => amount * 1.02 + TRADE_RESERVE;
const coinLabel = (mint) => {
  const c = pulse.coin(mint) || discover.coin(mint) || (tst.mint === mint ? tst.coin : null);
  return c?.symbol ? `$${esc(c.symbol)}` : short(mint);
};

function renderQb() {
  const body = $('qb-body');
  const w = tradeWallet();
  const label = coinLabel(qbs.mint);
  const need = buyNeed(qbs.amount);
  if (qbs.done) {
    body.innerHTML = `<h3>Bought ${label}</h3><p>${qbs.amount} SOL from your fresh wallet ${short(w.address)}. Your main wallet is nowhere on the chart.</p>
      <div class="btn-row"><a class="btn btn-ghost" href="https://solscan.io/tx/${qbs.done}" target="_blank" rel="noopener">Transaction</a><a class="btn btn-primary" href="#/trade?m=${qbs.mint}" data-qb="close">Open the coin</a></div>`;
    return;
  }
  if (!w) {
    body.innerHTML = `<h3>Quick buy ${label}</h3><p>Buys run from a fresh wallet made right here in your browser, so your main wallet never touches the chart. One wallet covers all your quick buys.</p>
      <button type="button" class="btn btn-primary btn-block" data-qb="make">Make my trading wallet</button>`;
    return;
  }
  if (!w.backedUp) {
    body.innerHTML = `<h3>Save the key first</h3><p>This wallet lives only in this browser. Keep a copy before you put SOL in it; it imports straight into Phantom.</p>${addrRow(w.address)}
      <div class="btn-row" style="margin-top:12px"><button type="button" class="btn btn-primary" data-qb="key-file">Download key file</button><button type="button" class="btn btn-ghost" data-qb="key-copy">Copy private key</button></div>`;
    return;
  }
  const enough = qbs.bal != null && qbs.bal >= need * 1e9;
  const top = Math.max(need - (qbs.bal || 0) / 1e9, 0.01);
  body.innerHTML = `<h3>Quick buy ${label}</h3>
    ${addrRow(w.address)}
    <div class="stats"><div class="stat${enough ? ' ok' : ''}"><b>${qbs.bal == null ? '...' : `${sol(qbs.bal)} SOL`}</b><span>In your trading wallet</span></div><div class="stat"><b>${need.toFixed(3)} SOL</b><span>Needed with fees</span></div></div>
    ${enough ? '' : `<p class="qb-hint">Send SOL to the address above from any wallet or exchange (it shows up here on its own), or:</p>
      <div class="fund"><input id="qb-fund" type="number" min="0" step="0.01" value="${(Math.ceil(top * 1000) / 1000).toFixed(3)}" inputmode="decimal" aria-label="SOL to send"><button type="button" class="btn btn-ghost" data-qb="fund">Send from my wallet</button></div>`}
    <button type="button" class="btn btn-primary btn-block qb-go" data-qb="buy" ${enough && !qbs.busy ? '' : 'disabled'}>${qbs.busy ? 'Buying...' : `Buy ${qbs.amount} SOL of ${label}`}</button>
    ${qbs.err ? `<p class="bad qb-err">${esc(qbs.err)}</p>` : ''}
    <small class="fee-note">Fees: pump.fun\'s trading fee, 0.5% to PumpPortal (which builds the trade) and Solana network fees. Incognito takes none. <a href="/legal.html#risk" target="_blank" rel="noopener">Risks</a></small>`;
}

async function pollQb() {
  const w = tradeWallet();
  if (!w || !w.backedUp || $('qb-sheet').hidden || qbs.done) return;
  try {
    qbs.bal = await balanceOf(w.address);
  } catch {
    return;
  }
  if (!qbs.busy && !document.activeElement?.closest?.('#qb-sheet input')) renderQb();
}
function openQb(mint, amount) {
  Object.assign(qbs, { mint, amount, bal: null, busy: false, done: '', err: '' });
  $('qb-sheet').hidden = false;
  renderQb();
  clearInterval(qbs.poll);
  qbs.poll = setInterval(pollQb, 3000);
  pollQb();
}
function closeQb() {
  $('qb-sheet').hidden = true;
  clearInterval(qbs.poll);
  qbs.poll = 0;
  paintPulseWallet();
}

$('qb-sheet').addEventListener('click', async (e) => {
  if (e.target === $('qb-sheet')) return closeQb();
  const cp = e.target.closest('[data-copy]');
  if (cp) return copy(cp.dataset.copy, 'Address copied');
  const b = e.target.closest('[data-qb]');
  if (!b) return;
  const act = b.dataset.qb;
  if (act === 'close') return closeQb();
  const w = tradeWallet();
  try {
    b.disabled = true;
    if (act === 'make') {
      const nw = await makeWallet('trade');
      tst.wallet = nw.address;
    } else if (act === 'key-file' || act === 'key-copy') {
      await exportKey(w, act === 'key-file' ? 'file' : 'copy');
    } else if (act === 'fund') {
      const sig = await fundFromMain(w.address, Number($('qb-fund').value));
      toast('Sent. The balance updates in a few seconds.');
      confirmSig(sig, 40_000).then(pollQb);
    } else if (act === 'buy') {
      qbs.busy = true;
      qbs.err = '';
      renderQb();
      try {
        qbs.done = await trade(w, 'buy', qbs.amount, qbs.mint);
      } catch (err) {
        qbs.err = err.message;
      }
      qbs.busy = false;
    }
  } catch (err) {
    qbs.err = err.message;
  } finally {
    if (b.isConnected) b.disabled = false;
  }
  renderQb();
  pollQb();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('qb-sheet').hidden) closeQb(); });

async function quickBuy(mint, btn) {
  const amount = Number(quickAmount());
  if (!(amount > 0)) return toast('Set a quick buy amount first.');
  const w = tradeWallet();
  if (!w || !w.backedUp) return openQb(mint, amount);
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    if ((await balanceOf(w.address)) < buyNeed(amount) * 1e9) return openQb(mint, amount);
    toast(`Buying ${amount} SOL from ${short(w.address)}...`);
    await trade(w, 'buy', amount, mint);
    toast('Bought. Open the coin to see it.');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    paintPulseWallet();
  }
}
const pulse = createPulse({ api, rpc, esc, toast, copy, quickAmount, quickBuy, onShow: () => paintPulseWallet() });
const discover = createDiscover({ api, esc, copy, quickAmount, quickBuy });
initFilters((list) => (list === 'discover' ? discover.render() : pulse.render()));
$('p-qb').addEventListener('input', () => discover.render());

// status bar: trading wallet, network, SOL price
// the Solana mark (the official three-bar logo with its own gradient)
const SOL_MARK = '<svg class="sol-mark" viewBox="0 0 397.7 311.7" width="14" height="11" role="img" aria-label="SOL"><defs><linearGradient id="solmark-g" x1="360.9" y1="-37.5" x2="141.2" y2="383.3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00ffa3"/><stop offset="1" stop-color="#dc1fff"/></linearGradient></defs><g fill="url(#solmark-g)"><path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"/><path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"/><path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"/></g></svg>';
let sbTimer = 0;
async function paintStatus() {
  paintPulseWallet();
  try {
    const r = await api('/api/market?mints=');
    $('sb-sol').innerHTML = r.solUsd ? `${SOL_MARK}<b>$${r.solUsd.toFixed(2)}</b>` : '';
    await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    $('sb-live').innerHTML = '<i class="dot on"></i>Solana mainnet';
  } catch {
    $('sb-live').innerHTML = '<i class="dot"></i>Network unreachable';
  }
}

startXCards({ api, esc });

async function paintPulseWallet() {
  const el = $('p-wallet');
  const w = tradeWallet();
  if (!w || !w.backedUp) {
    el.innerHTML = 'Trading wallet: <a href="#/trade">set one up</a>';
    return;
  }
  el.innerHTML = `Trading wallet <a href="#/trade?w=${w.address}">${short(w.address)}</a> <b id="p-bal">...</b>`;
  try {
    const lam = await balanceOf(w.address);
    if ($('p-bal')) $('p-bal').textContent = `${sol(lam)} SOL`;
  } catch { /* later */ }
}

$('q-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const m = $('q').value.trim();
  if (!isAddress(m)) return toast('Paste a Solana contract address.');
  $('q').value = '';
  location.hash = `#/trade?m=${m}`;
});

function route() {
  const [r, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const view = r === 'terminal' ? 'discover' : ['discover', 'pulse', 'launch', 'trade', 'wallets'].includes(r) ? r : 'home';
  document.body.classList.toggle('on-home', view === 'home');
  $('v-home').hidden = view !== 'home';
  $('v-launch').hidden = view !== 'launch';
  $('v-trade').hidden = view !== 'trade';
  $('v-terminal').hidden = view !== 'pulse';
  $('v-discover').hidden = view !== 'discover';
  document.body.classList.toggle('is-term', view !== 'home');
  // the pixel blocks belong to the homepage only; every app view has the terminal's plain background
  pixels.strength = view === 'home' ? 1 : 0;
  if (view === 'pulse') pulse.show();
  else pulse.hide();
  if (view === 'discover') discover.show();
  else discover.hide();
  clearInterval(sbTimer);
  if (view !== 'home') {
    paintStatus();
    sbTimer = setInterval(paintStatus, 20_000);
  }
  $('v-wallets').hidden = view !== 'wallets';
  if (view === 'trade') {
    const q = new URLSearchParams(query);
    if (q.get('w') && byAddress(q.get('w'))) tst.wallet = q.get('w');
    renderTradeWallet();
    loadCoin(q.get('m') || '');
    startTradePoll();
    clearInterval(tst.coinTimer);
    tst.coinTimer = setInterval(refreshCoin, 10_000);
  } else {
    stopTradePoll();
    clearInterval(tst.coinTimer);
  }
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.r === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (view === 'launch') {
    renderDep();
    startPoll();
  } else {
    stopPoll();
  }
  if (view === 'wallets') {
    renderWallets();
    refreshBalances();
  }
  window.scrollTo(0, 0);
}
// page change: the screen fades to grey, the next page is put in place underneath, then the grey
// fades away to show it. A second click mid-fade just retargets the page that is revealed.
const fader = document.createElement('div');
fader.className = 'fader';
fader.setAttribute('aria-hidden', 'true');
document.body.append(fader);
const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
let fadeTimer = 0;
window.addEventListener('hashchange', () => {
  if (instant) return route();
  clearTimeout(fadeTimer);
  fader.classList.add('on');
  fadeTimer = setTimeout(() => {
    route();
    requestAnimationFrame(() => requestAnimationFrame(() => fader.classList.remove('on')));
  }, 300);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && st.poll) pollBalance(); });

(async () => {
  st.signOk = await canSign();
  route();
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('is-in')));
  try {
    const h = await (await fetch('/api/health')).json();
    st.serverHost = !!(h.pinata || h.blob);
    st.canHost = true; // with no server key, coins are hosted on Arweave from the browser
    if (!$('v-launch').hidden) renderDep();
    if (h.gate) {
      try {
        await api('/api/unlock', {});
      } catch { /* api() opened the gate */ }
    }
  } catch { /* offline: the actions will say so */ }
})();
