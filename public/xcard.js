// Hover preview for X links: hold the pointer on any element with data-xprev="<x.com link>" and a
// small card shows the profile (avatar, name, followers, bio) or the tweet (author, text, image,
// counts). Data comes from /api/x (FxTwitter, cached). One card element serves the whole page.
import { safeUrl } from './safe.js';

const n = (v) => (v == null ? '-' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));
const when = (t) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  return s < 3600 ? `${Math.max(1, (s / 60) | 0)}m` : s < 86400 ? `${(s / 3600) | 0}h` : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export function startXCards({ api, esc }) {
  const card = document.createElement('div');
  card.className = 'xcard';
  card.hidden = true;
  card.setAttribute('role', 'tooltip');
  document.body.append(card);
  const cache = new Map();
  let target = null, showT = 0, hideT = 0;

  const author = (a) => `
    <div class="xc-who">
      ${a?.avatar ? `<img src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div><b>${esc(a?.name || '')}</b><span>@${esc(a?.handle || '')}</span></div>
    </div>`;

  function html(p, href) {
    if (!p) return `<p class="xc-none">No preview for this link.</p><a class="xc-open" href="${esc(safeUrl(href))}" target="_blank" rel="noopener noreferrer">Open on X</a>`;
    if (p.kind === 'community') return `<p class="xc-kind">X community</p><p class="xc-none">Communities have no public preview.</p><a class="xc-open" href="${esc(safeUrl(href))}" target="_blank" rel="noopener noreferrer">Open on X</a>`;
    if (p.kind === 'tweet') {
      return `${author(p.author)}
        <p class="xc-text">${esc(p.text || '')}</p>
        ${p.media ? `<img class="xc-media" src="${esc(p.media)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div class="xc-stats"><span>${n(p.replies)} replies</span><span>${n(p.retweets)} reposts</span><span>${n(p.likes)} likes</span>${p.views != null ? `<span>${n(p.views)} views</span>` : ''}<span class="xc-when">${when(p.at)}</span></div>`;
    }
    return `${p.banner && safeUrl(p.banner) !== '#' ? `<div class="xc-banner" style="background-image:url('${esc(encodeURI(decodeURI(safeUrl(p.banner))))}')"></div>` : ''}
      ${author(p)}
      ${p.bio ? `<p class="xc-text">${esc(p.bio)}</p>` : ''}
      <div class="xc-stats"><span><b>${n(p.followers)}</b> followers</span><span><b>${n(p.following)}</b> following</span></div>`;
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = Math.min(innerWidth - cw - 10, Math.max(10, r.left + r.width / 2 - cw / 2));
    let y = r.bottom + 8;
    if (y + ch > innerHeight - 10) y = Math.max(10, r.top - ch - 8);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  async function show(el) {
    const href = el.dataset.xprev;
    target = el;
    card.innerHTML = '<p class="xc-none">Loading...</p>';
    card.hidden = false;
    place(el);
    let p = cache.get(href);
    if (p === undefined) {
      try {
        p = (await api(`/api/x?url=${encodeURIComponent(href)}`)).preview;
      } catch {
        p = null;
      }
      cache.set(href, p);
    }
    if (target !== el) return;
    card.innerHTML = html(p, href);
    place(el);
    card.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => target === el && place(el), { once: true }));
  }
  const hide = () => {
    target = null;
    card.hidden = true;
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-xprev]');
    if (el) {
      clearTimeout(hideT);
      if (el !== target) {
        clearTimeout(showT);
        showT = setTimeout(() => show(el), 220);
      }
    } else if (e.target.closest?.('.xcard')) {
      clearTimeout(hideT);
    }
  });
  document.addEventListener('mouseout', (e) => {
    const from = e.target.closest?.('[data-xprev], .xcard');
    if (!from) return;
    const to = e.relatedTarget?.closest?.('[data-xprev], .xcard');
    if (to) return;
    clearTimeout(showT);
    hideT = setTimeout(hide, 180);
  });
  addEventListener('scroll', hide, { passive: true, capture: true });
}
