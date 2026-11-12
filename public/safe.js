// Links that come from outside (coin metadata, DexScreener, GeckoTerminal, X) are only ever used as
// plain http(s) links. Anything else (javascript:, data:, odd schemes) becomes a dead link, because
// the fresh wallets' keys live in this page's storage and nothing from a feed may run here.
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '#';
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}
