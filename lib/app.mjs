// Every route as one (req, res) handler. server.mjs runs it locally;
// api/index.mjs is this file bundled for Vercel (build.mjs).
//
// The server holds no key and signs nothing. It does four things:
//   - hosts the coin's image + metadata (pump.fun IPFS first, Vercel Blob as fallback)
//   - asks PumpPortal for the UNSIGNED create / claim-fees transaction
//   - relays a short allowlist of Solana RPC calls
//   - serves the static site when run locally
// The fresh deployer wallet and the mint key are made and used in the browser.
import { ROOT, num } from './env.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';

const PUBLIC = join(ROOT, 'public');
const TRADE_LOCAL = 'https://pumpportal.fun/api/trade-local';
const RPC = () => process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MAX_BUY = num('LAUNCH_MAX_BUY_SOL', 20);
const PRIORITY = num('LAUNCH_PRIORITY_FEE_SOL', 0.0005);
const BLOB_TOKEN = () => process.env.BLOB_READ_WRITE_TOKEN || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

class Refused extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    const b = req.body;
    if (Buffer.isBuffer(b) || typeof b === 'string') {
      try {
        return JSON.parse(b.toString() || '{}');
      } catch {
        throw new Refused('Body was not JSON.');
      }
    }
    return b;
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Refused('That is too big. Use an image under 3 MB.', 413);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Refused('Body was not JSON.');
  }
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (s) => typeof s === 'string' && B58.test(s);
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function optUrl(v, label) {
  const s = clean(v, 200);
  if (!s) return '';
  const u = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') throw new Error();
    return p.href;
  } catch {
    throw new Refused(`${label} is not a link.`);
  }
}

/* ------------------------------------------------------------- password */
function gateOk(req) {
  const want = process.env.PAD_PASSWORD || '';
  if (!want) return true;
  const got = String(req.headers['x-pad-key'] || '');
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(want).digest();
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------- metadata */
async function pumpIpfs({ bytes, type, name, symbol, description, twitter, telegram, website }) {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type }), `image.${IMAGE_TYPES[type]}`);
    fd.append('name', name);
    fd.append('symbol', symbol);
    fd.append('description', description);
    fd.append('twitter', twitter);
    fd.append('telegram', telegram);
    fd.append('website', website);
    fd.append('showName', 'true');
    const res = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: fd, redirect: 'manual', signal: AbortSignal.timeout(40_000) });
    if (!res.ok) return { ok: false, why: `pump.fun IPFS answered ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body?.metadataUri) return { ok: false, why: 'pump.fun IPFS returned no metadata link' };
    return { ok: true, uri: body.metadataUri, image: body.metadata?.image ?? null };
  } catch (e) {
    return { ok: false, why: `pump.fun IPFS unreachable (${e.message})` };
  }
}

/** Pin the image, then the metadata JSON, to public IPFS through Pinata (PINATA_JWT). */
async function pinataHost({ bytes, type, doc }) {
  const jwt = process.env.PINATA_JWT || '';
  if (!jwt) return null;
  const pin = async (blob, filename) => {
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('network', 'public');
    let res = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: fd, signal: AbortSignal.timeout(40_000) });
    if (res.ok) {
      const cid = (await res.json())?.data?.cid;
      if (cid) return cid;
    }
    // older keys only reach the legacy pinning API
    const fd2 = new FormData();
    fd2.append('file', blob, filename);
    res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: fd2, signal: AbortSignal.timeout(40_000) });
    if (!res.ok) throw new Error(`Pinata answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const cid = (await res.json())?.IpfsHash;
    if (!cid) throw new Error('Pinata returned no CID');
    return cid;
  };
  const imgCid = await pin(new Blob([bytes], { type }), `image.${IMAGE_TYPES[type]}`);
  const image = `https://ipfs.io/ipfs/${imgCid}`;
  const metaCid = await pin(new Blob([JSON.stringify({ ...doc, image })], { type: 'application/json' }), 'metadata.json');
  return { uri: `https://ipfs.io/ipfs/${metaCid}`, image };
}

async function blobHost({ bytes, type, doc }) {
  const token = BLOB_TOKEN();
  if (!token) return null;
  const { put } = await import('@vercel/blob');
  const id = randomUUID();
  const opts = { access: 'public', token, addRandomSuffix: false, allowOverwrite: false };
  const img = await put(`coins/${id}.${IMAGE_TYPES[type]}`, bytes, { ...opts, contentType: type });
  const meta = await put(`coins/${id}.json`, JSON.stringify({ ...doc, image: img.url }), { ...opts, contentType: 'application/json' });
  return { uri: meta.url, image: img.url };
}

/* ------------------------------------------------------------ PumpPortal */
async function pumpPortal(body) {
  let res;
  try {
    res = await fetch(TRADE_LOCAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Refused(`PumpPortal could not be reached (${e.message}). Nothing was signed.`, 502);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Refused(`PumpPortal refused it: ${text || res.status}. Nothing was signed.`, 502);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Refused('PumpPortal returned an empty transaction.', 502);
  return bytes.toString('base64');
}

/* ------------------------------------------------------------------- RPC */
const RPC_METHODS = new Set([
  'getBalance', 'getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses',
  'getTokenAccountsByOwner', 'getAccountInfo', 'getMultipleAccounts', 'simulateTransaction',
]);

// SOLANA_RPC first when set, then two keyless public endpoints. A rate limit, a server error or a
// dropped connection moves on to the next one. Resending a signed transaction is safe: it carries
// the same signature, so the network lands it at most once.
const RPC_ENDPOINTS = () => [RPC(), 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']
  .filter((v, i, a) => v && a.indexOf(v) === i);

async function relay({ method, params }) {
  if (!RPC_METHODS.has(method)) throw new Refused(`RPC method ${method} is not relayed.`);
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: Array.isArray(params) ? params : [] });
  let last = 'no endpoint';
  for (const endpoint of RPC_ENDPOINTS()) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) {
        last = `answered ${res.status}`;
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!body) {
        last = `answered ${res.status} with something that was not JSON`;
        continue;
      }
      if (body.error && /429|rate limit|too many requests/i.test(String(body.error.message || ''))) {
        last = body.error.message;
        continue;
      }
      return body;
    } catch (e) {
      last = e.message;
    }
  }
  throw new Refused(`Solana could not be reached (${last}).`, 502);
}

/* ------------------------------------------------------------- caching */
const CACHE = new Map();
async function cached(key, ms, fn) {
  const hit = CACHE.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  // a miss is kept briefly only, so a flaky upstream does not pin "nothing" for the full period
  CACHE.set(key, { value, until: Date.now() + (value == null ? Math.min(ms, 10_000) : ms) });
  if (CACHE.size > 2000) for (const k of [...CACHE.keys()].slice(0, 500)) CACHE.delete(k);
  return value;
}
/**
 * One GeckoTerminal pool list for Solana (keyless, ~30 calls a minute), as coins:
 * { mint, name, symbol, image, pool, dex, createdAt, marketCap, liquidity, vol, chg, tx }.
 * For a pump-fun pool the pool address IS the coin's bonding curve.
 */
async function gecko(pathAndQuery) {
  try {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/${pathAndQuery}${sep}include=base_token`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const tokens = new Map((j.included || []).filter((t) => t.type === 'token').map((t) => [t.id, t.attributes]));
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const tf = (o, f = num) => ({ m5: f(o?.m5), h1: f(o?.h1), h6: f(o?.h6), h24: f(o?.h24) });
    return (j.data || []).map((p) => {
      const a = p.attributes || {};
      const tid = p.relationships?.base_token?.data?.id || '';
      const t = tokens.get(tid) || {};
      const mint = t.address || tid.replace(/^solana_/, '');
      if (!isAddress(mint)) return null;
      return {
        mint, name: t.name || (a.name || '').split(' / ')[0], symbol: t.symbol || '', image: t.image_url && !/missing/.test(t.image_url) ? t.image_url : null,
        pool: a.address, dex: p.relationships?.dex?.data?.id || '', createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
        marketCap: num(a.market_cap_usd) ?? num(a.fdv_usd), liquidity: num(a.reserve_in_usd),
        vol: tf(a.volume_usd), chg: tf(a.price_change_percentage),
        tx: { m5: a.transactions?.m5, h1: a.transactions?.h1, h6: a.transactions?.h6, h24: a.transactions?.h24 },
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const WSOL = 'So11111111111111111111111111111111111111112';
const solUsd = () => cached('solusd', 60_000, async () => {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${WSOL}`, { signal: AbortSignal.timeout(8_000) });
    const pairs = r.ok ? await r.json() : [];
    // the deepest SOL/stable pair
    const p = (pairs || []).filter((x) => x?.baseToken?.address === WSOL && /USD/.test(x?.quoteToken?.symbol || ''))
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return Number(p?.priceUsd) || null;
  } catch {
    return null;
  }
});

/* ----------------------------------------------------------------- static */
async function serveStatic(req, res, path) {
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep)) return send(res, 404, { error: 'Not found.' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    return res.end(body);
  } catch {
    // unknown paths fall back to the app shell
    const body = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
    return res.end(body);
  }
}

/* ------------------------------------------------------------------ routes */
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    return serveStatic(req, res, path);
  }

  if (method === 'GET' && path === '/api/health') {
    // ?probe=1 asks pump.fun's upload endpoint for its status without uploading anything:
    // 403 means this server's region is geo-blocked, anything else means launches can use pump.fun IPFS
    if (url.searchParams.get('probe') === '1') {
      let ipfs = null;
      try {
        const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: new FormData(), redirect: 'manual', signal: AbortSignal.timeout(8_000) });
        ipfs = { status: r.status, location: r.headers.get('location'), server: r.headers.get('server'), body: (await r.text()).slice(0, 160) };
      } catch { /* unreachable */ }
      return send(res, 200, { pumpIpfsStatus: ipfs, region: process.env.VERCEL_REGION || 'local' });
    }
    return send(res, 200, { ok: true, gate: !!process.env.PAD_PASSWORD, blob: !!BLOB_TOKEN(), pinata: !!process.env.PINATA_JWT, maxBuy: MAX_BUY, priorityFee: PRIORITY });
  }

  if (!gateOk(req)) throw new Refused('Wrong password.', 401);

  if (method === 'POST' && path === '/api/unlock') return send(res, 200, { ok: true });

  if (method === 'POST' && path === '/api/metadata') {
    const b = await readJson(req, 4_400_000);
    const name = clean(b.name, 32);
    const symbol = clean(b.symbol, 10).toUpperCase();
    const description = clean(b.description, 1000);
    if (!name) throw new Refused('Give the coin a name.');
    if (!/^[A-Z0-9$]{1,10}$/.test(symbol)) throw new Refused('The ticker is 1 to 10 letters or digits.');
    const twitter = optUrl(b.twitter, 'X link');
    const telegram = optUrl(b.telegram, 'Telegram link');
    const website = optUrl(b.website, 'Website');
    const m = String(b.image || '').match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Refused('Add a PNG, JPG, GIF or WebP image.');
    const type = m[1];
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 3 * 1024 * 1024) throw new Refused('Use an image under 3 MB.', 413);

    const ipfs = await pumpIpfs({ bytes, type, name, symbol, description, twitter, telegram, website });
    if (ipfs.ok) return send(res, 200, { uri: ipfs.uri, image: ipfs.image, via: 'pump.fun IPFS' });

    const doc = { name, symbol, description, showName: true, createdOn: 'https://pump.fun', twitter, telegram, website };
    for (const [via, host] of [['IPFS via Pinata', pinataHost], ['Vercel Blob', blobHost]]) {
      let hosted;
      try {
        hosted = await host({ bytes, type, doc });
      } catch (e) {
        throw new Refused(`${ipfs.why}, and ${via} failed too (${e.message}). Nothing was signed.`, 502);
      }
      if (hosted) return send(res, 200, { uri: hosted.uri, image: hosted.image, via });
    }
    throw new Refused(`${ipfs.why} (pump.fun blocks UK requests). Set PINATA_JWT, or run the pad from a server outside the UK, so the coin image has somewhere to live. Nothing was signed.`, 503);
  }

  if (method === 'POST' && path === '/api/create') {
    const b = await readJson(req);
    if (!isAddress(b.publicKey)) throw new Refused('No deployer wallet.');
    if (!isAddress(b.mint)) throw new Refused('No mint address.');
    if (b.publicKey === b.mint) throw new Refused('The mint and the deployer cannot be the same key.');
    const name = clean(b.name, 32);
    const symbol = clean(b.symbol, 10).toUpperCase();
    const uri = String(b.uri || '');
    if (!name || !symbol) throw new Refused('Name and ticker are required.');
    if (!/^https:\/\/\S{8,190}$/.test(uri)) throw new Refused('The metadata link is missing.');
    const buySol = Number(b.buySol) || 0;
    if (buySol < 0 || buySol > MAX_BUY) throw new Refused(`The first buy is 0 to ${MAX_BUY} SOL here.`);
    const tx = await pumpPortal({
      publicKey: b.publicKey,
      action: 'create',
      tokenMetadata: { name, symbol, uri },
      mint: b.mint,
      denominatedInSol: 'true',
      amount: buySol,
      slippage: 10,
      priorityFee: PRIORITY,
      pool: 'pump',
    });
    return send(res, 200, { tx });
  }

  if (method === 'POST' && path === '/api/claim') {
    const b = await readJson(req);
    if (!isAddress(b.publicKey)) throw new Refused('No wallet.');
    const tx = await pumpPortal({ publicKey: b.publicKey, action: 'collectCreatorFee', priorityFee: 0.000051, pool: 'pump' });
    return send(res, 200, { tx });
  }

  if (method === 'POST' && path === '/api/rpc') {
    const b = await readJson(req, 256 * 1024);
    return send(res, 200, await relay(b));
  }

  // Buy or sell any pump.fun coin. pool 'auto' routes a graduated coin to PumpSwap.
  if (method === 'POST' && path === '/api/trade') {
    const b = await readJson(req);
    if (!isAddress(b.publicKey)) throw new Refused('No wallet.');
    if (!isAddress(b.mint)) throw new Refused('That is not a coin address.');
    let amount;
    let denominatedInSol;
    if (b.action === 'buy') {
      amount = Number(b.amount);
      if (!(amount > 0) || amount > MAX_BUY) throw new Refused(`Buy 0 to ${MAX_BUY} SOL here.`);
      denominatedInSol = 'true';
    } else if (b.action === 'sell') {
      const pct = String(b.amount || '');
      if (!/^(100|[1-9][0-9]?)%$/.test(pct)) throw new Refused('Sell 1% to 100%.');
      amount = pct;
      denominatedInSol = 'false';
    } else {
      throw new Refused('Buy or sell.');
    }
    let tx;
    try {
      tx = await pumpPortal({ publicKey: b.publicKey, action: b.action, mint: b.mint, amount, denominatedInSol, slippage: 15, priorityFee: PRIORITY, pool: 'auto' });
    } catch (e) {
      // PumpPortal answers a bare "Bad Request" when a wallet sells a coin it does not hold
      if (b.action === 'sell' && /Bad Request/.test(e.message)) throw new Refused('Nothing to sell: this wallet does not hold that coin yet. Nothing was signed.');
      throw e;
    }
    return send(res, 200, { tx });
  }

  // Terminal: market data for up to 30 coins in one DexScreener call.
  if (method === 'GET' && path === '/api/market') {
    const mints = String(url.searchParams.get('mints') || '').split(',').filter(isAddress).slice(0, 30);
    if (!mints.length) return send(res, 200, { coins: {}, solUsd: await solUsd() });
    const key = mints.slice().sort().join(',');
    const coins = await cached(`m:${key}`, 8_000, async () => {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { signal: AbortSignal.timeout(10_000) });
      const pairs = r.ok ? await r.json() : [];
      const out = {};
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const m = p?.baseToken?.address;
        if (!mints.includes(m)) continue;
        if (out[m] && (out[m].liquidity || 0) >= (p.liquidity?.usd || 0)) continue;
        out[m] = {
          name: p.baseToken.name, symbol: p.baseToken.symbol, image: p.info?.imageUrl || null,
          priceUsd: Number(p.priceUsd) || null, marketCap: p.marketCap ?? p.fdv ?? null, liquidity: p.liquidity?.usd ?? null,
          volume: p.volume?.h24 ?? null, change5m: p.priceChange?.m5 ?? null, change1h: p.priceChange?.h1 ?? null, change24h: p.priceChange?.h24 ?? null,
          buys: p.txns?.h24?.buys ?? null, sells: p.txns?.h24?.sells ?? null, dex: p.dexId, pair: p.pairAddress, url: p.url, createdAt: p.pairCreatedAt ?? null,
          // per timeframe, for the Discover table (m5, h1, h6, h24)
          vol: p.volume || {}, chg: p.priceChange || {}, tx: p.txns || {}, boosts: p.boosts?.active ?? 0, paid: !!p.info,
          socials: [...(p.info?.socials || []).map((x) => ({ type: x.type, url: x.url })), ...(p.info?.websites || []).slice(0, 1).map((x) => ({ type: 'website', url: x.url }))],
        };
      }
      return out;
    });
    return send(res, 200, { coins, solUsd: await solUsd() });
  }

  // Terminal: the three Pulse columns from GeckoTerminal, so they match the whole of pump.fun rather
  // than a curated slice: newest pump.fun launches, the busiest bonding curves (Final stretch candidates;
  // the browser reads their progress on chain), and the busiest coins that graduated to PumpSwap in the
  // last day. The live websocket adds to these as things happen.
  if (method === 'GET' && path === '/api/pulse/lists') {
    const lists = await cached('pulse-lists', 30_000, async () => {
      // three calls per refresh: GeckoTerminal allows about 30 a minute for everyone on this server.
      // (Its per-dex list for PumpSwap is empty, so graduations come from new pools and trending.)
      const [n1, n2, f1] = await Promise.all([
        'new_pools?page=1', 'new_pools?page=2',
        'dexes/pump-fun/pools?sort=h24_volume_usd_desc&page=1',
      ].map(gecko));
      if (![n1, n2, f1].some((l) => l.length)) return null; // rate limited: try again soon, do not pin empties
      const trending = await cached('trending', 60_000, async () => [
        ...(await gecko('trending_pools?duration=1h&page=1')), ...(await gecko('trending_pools?duration=6h&page=1')),
      ]);
      const n3 = [];
      const f2 = [];
      const fresh = [...n1, ...n2, ...n3];
      const uniq = (list) => [...new Map(list.map((c) => [c.mint, c])).values()];
      return {
        new: uniq(fresh.filter((c) => c.dex === 'pump-fun')).sort((a, b) => b.createdAt - a.createdAt),
        fin: uniq([...f1, ...f2, ...trending.filter((c) => c.dex === 'pump-fun')]),
        // graduations: brand-new PumpSwap pools and trending graduated pump.fun coins, newest first
        mig: uniq([...fresh, ...trending].filter((c) => c.dex === 'pumpswap' && /pump$/.test(c.mint))).sort((a, b) => b.createdAt - a.createdAt),
      };
    });
    return send(res, 200, lists || { new: [], fin: [], mig: [] });
  }

  // Terminal: pump.fun coins people are looking at right now (GeckoTerminal trending, DexScreener's
  // latest profiles and boosts) for the Discover table.
  if (method === 'GET' && path === '/api/pulse/seed') {
    const mints = await cached('seed', 30_000, async () => {
      const trending = await cached('trending', 60_000, async () => [
        ...(await gecko('trending_pools?duration=1h&page=1')), ...(await gecko('trending_pools?duration=6h&page=1')),
      ]);
      const lists = await Promise.all(['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1'].map((p) =>
        fetch(`https://api.dexscreener.com/${p}`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : [])).catch(() => [])));
      lists.unshift(trending.map((c) => ({ chainId: 'solana', tokenAddress: c.mint })));
      const seen = new Set();
      for (const list of lists) for (const t of Array.isArray(list) ? list : []) {
        if (t?.chainId === 'solana' && /pump$/.test(t.tokenAddress || '') && isAddress(t.tokenAddress)) seen.add(t.tokenAddress);
      }
      return [...seen].slice(0, 90);
    });
    return send(res, 200, { mints });
  }

  // Terminal: a new coin's metadata JSON (image and socials). Public https only, small, cached.
  if (method === 'GET' && path === '/api/meta') {
    const uri = String(url.searchParams.get('uri') || '');
    let u;
    try {
      u = new URL(uri);
    } catch {
      throw new Refused('Bad link.');
    }
    if (u.protocol !== 'https:' || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(u.hostname) || !u.hostname.includes('.')) throw new Refused('Bad link.');
    const meta = await cached(`meta:${uri}`, 3_600_000, async () => {
      const r = await fetch(u.href, { redirect: 'follow', signal: AbortSignal.timeout(6_000) });
      if (!r.ok) return null;
      const text = (await r.text()).slice(0, 65_536);
      const j = JSON.parse(text);
      const link = (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v.slice(0, 300) : null);
      let image = link(j.image);
      if (!image && typeof j.image === 'string' && j.image.startsWith('ipfs://')) image = `https://ipfs.io/ipfs/${j.image.slice(7)}`;
      return { image, twitter: link(j.twitter), telegram: link(j.telegram), website: link(j.website) };
    }).catch(() => null);
    return send(res, 200, { meta }, { 'cache-control': 'public, max-age=3600' });
  }

  // Terminal: a small preview of a coin's X link (profile, tweet or community), via FxTwitter (keyless).
  if (method === 'GET' && path === '/api/x') {
    let u;
    try {
      u = new URL(String(url.searchParams.get('url') || ''));
    } catch {
      throw new Refused('Bad link.');
    }
    if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) throw new Refused('Not an X link.');
    const parts = u.pathname.split('/').filter(Boolean);
    const preview = await cached(`x:${parts.join('/')}`, 600_000, async () => {
      if (parts[0] === 'i' && parts[1] === 'communities' && /^\d+$/.test(parts[2] || '')) return { kind: 'community', id: parts[2] };
      const handle = parts[0];
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return null;
      // FxTwitter answers a random share of valid lookups with 404 "User not found", so try a few times
      const fx = async (p) => {
        for (let i = 0; i < 4; i += 1) {
          const r = await fetch(`https://api.fxtwitter.com/${p}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; incognito-pad)' }, signal: AbortSignal.timeout(8_000) });
          if (r.ok) return r.json();
          if (r.status !== 404) return null;
        }
        return null;
      };
      const user = (a) => a && { name: a.name, handle: a.screen_name, avatar: a.avatar_url, followers: a.followers, following: a.following, bio: a.description, banner: a.banner_url, joined: a.joined };
      if (parts[1] === 'status' && /^\d+$/.test(parts[2] || '')) {
        const t = (await fx(`status/${parts[2]}`))?.tweet;
        if (!t) return null;
        const m = t.media?.photos?.[0]?.url || t.media?.videos?.[0]?.thumbnail_url || null;
        return { kind: 'tweet', author: user(t.author), text: t.text, at: t.created_timestamp ? t.created_timestamp * 1000 : null, likes: t.likes, retweets: t.retweets, replies: t.replies, views: t.views, media: m };
      }
      const a = (await fx(handle))?.user;
      return a ? { kind: 'profile', ...user(a) } : null;
    }).catch(() => null);
    return send(res, 200, { preview });
  }

  // Coin details for the trade screen, from DexScreener (keyless). Missing details never block a trade.
  if (method === 'GET' && path === '/api/coin') {
    const mint = url.searchParams.get('mint') || '';
    if (!isAddress(mint)) throw new Refused('That is not a coin address.');
    let pairs = [];
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) pairs = (await r.json()) || [];
    } catch { /* no details */ }
    const p = (Array.isArray(pairs) ? pairs : []).filter((x) => x?.baseToken?.address === mint)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!p) return send(res, 200, { coin: null });
    return send(res, 200, {
      coin: {
        name: p.baseToken.name, symbol: p.baseToken.symbol, image: p.info?.imageUrl || null,
        priceUsd: Number(p.priceUsd) || null, marketCap: p.marketCap ?? p.fdv ?? null,
        change24h: p.priceChange?.h24 ?? null, dex: p.dexId, url: p.url,
      },
    });
  }

  throw new Refused('Not found.', 404);
}

export default async function handle(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e instanceof Refused ? e.status : 500;
    if (!(e instanceof Refused)) console.error(e);
    send(res, status, { error: e instanceof Refused ? e.message : 'Something broke on the server.' });
  }
}
