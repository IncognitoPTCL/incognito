// Motion, with GSAP 3.13 (vendored in /vendor, loaded before the app).
//   Homepage: headline words rise through masks, the description rises line by line, the actions pop.
//   Every route: the current view fades out (140 ms), the next fades in rising 8 px (240 ms); the
//   header and status bar never move. Large panels open with a clip from their top edge.
//   Feedback: rows pop in as they arrive, sheets scale and slide in, the nav and timeframe indicators
//   slide, a figure rolls only when its value actually changes.
// Transform, opacity and clip only. Under prefers-reduced-motion (or without GSAP) nothing moves and
// everything is shown at once.
const g = window.gsap;
const ST = window.SplitText;
export const still = !g || matchMedia('(prefers-reduced-motion: reduce)').matches;
if (g && ST) g.registerPlugin(ST);
if (!still) document.documentElement.classList.add('motion');

/* ------------------------------------------------------------- homepage */
let homeDone = false;
export function revealHome() {
  const root = document.getElementById('v-home');
  if (!root || homeDone) return;
  homeDone = true;
  const h1 = root.querySelector('.home-title');
  const lede = root.querySelector('.home-lede');
  const ctas = root.querySelectorAll('.home-ctas .btn');
  const show = () => g?.set([h1, lede, ...ctas], { visibility: 'visible' });
  if (still || !ST) return show && document.documentElement.classList.remove('motion');
  document.fonts.ready.then(() => {
    // split the line spans themselves, never their flex parent (SplitText 3.13 wraps lines in it)
    const words = [];
    h1.querySelectorAll('span').forEach((line) => words.push(...ST.create(line, { type: 'words', mask: 'words', wordsClass: 'hw' }).words));
    show();
    const tl = g.timeline({ delay: 0.12 });
    tl.from(words, { yPercent: 110, duration: 0.65, stagger: 0.055, ease: 'power4.out' });
    ST.create(lede, {
      type: 'lines', mask: 'lines', linesClass: 'hl', autoSplit: true,
      // re-split on resize keeps the natural wrapping; the tween follows the new lines
      onSplit: (self) => g.from(self.lines, { yPercent: 105, duration: 0.55, stagger: 0.07, ease: 'power3.out', delay: tl.totalDuration() - 0.3 }),
    });
    tl.from(ctas, { scale: 0.94, y: 12, duration: 0.5, stagger: 0.07, ease: 'back.out(1.15)', clearProps: 'transform' }, '-=0.15');
  });
}

/* ------------------------------------------------------------ routes */
export function routeOut(el) {
  if (still || !el || el.hidden) return Promise.resolve();
  return new Promise((done) => g.to(el, { opacity: 0, duration: 0.14, ease: 'power2.out', onComplete: done }));
}
export function routeIn(el) {
  if (still || !el) return;
  g.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.24, ease: 'power2.out', clearProps: 'opacity,transform' });
  // large panels open from their top edge, a beat after the view arrives
  const panels = el.querySelectorAll(':scope .card, :scope .pcol, :scope .dtable, :scope .coin-bar, :scope .chart-box, :scope .trade-box');
  if (panels.length) {
    g.fromTo(panels, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.5, stagger: 0.06, ease: 'power3.out', delay: 0.06, clearProps: 'clipPath' });
  }
}

/* -------------------------------------------------------------- entrances */
/** Peer items (wallet rows): the brief's card pop. */
export function popItems(items) {
  if (still || !items?.length) return;
  g.fromTo(items, { scale: 0.94, y: 20 }, { scale: 1, y: 0, duration: 0.55, stagger: 0.07, ease: 'back.out(1.15)', clearProps: 'transform' });
}
/** One row arriving in a live list: short, small overshoot. */
export function popRow(el) {
  if (still || !el) return;
  g.fromTo(el, { scale: 0.96, y: 10 }, { scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.15)', clearProps: 'transform' });
}
/** Rows of a table on its first fill. */
export function popRows(rows) {
  if (still || !rows?.length) return;
  g.fromTo(rows, { y: 8, scale: 0.985 }, { y: 0, scale: 1, duration: 0.35, stagger: 0.03, ease: 'back.out(1.15)', clearProps: 'transform' });
}
/** A dialog or sheet: a restrained scale and slide. */
export function openSheet(overlay) {
  if (still || !overlay) return;
  const sheet = overlay.firstElementChild;
  g.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'power2.out', clearProps: 'opacity' });
  if (sheet) g.fromTo(sheet, { scale: 0.96, y: 10 }, { scale: 1, y: 0, duration: 0.26, ease: 'power2.out', clearProps: 'transform' });
}

/* -------------------------------------------------------------- indicators */
/** Slide `ind` under `target` (an element inside the same positioned parent). */
export function slideTo(ind, target, instant = false) {
  if (!ind) return;
  if (!target) {
    if (g) g.to(ind, { opacity: 0, duration: still || instant ? 0 : 0.2 });
    else ind.style.opacity = '0';
    return;
  }
  const props = { x: target.offsetLeft, width: target.offsetWidth, opacity: 1 };
  if (g) g.to(ind, { ...props, duration: still || instant ? 0 : 0.35, ease: 'power3.out' });
  else Object.assign(ind.style, { transform: `translateX(${props.x}px)`, width: `${props.width}px`, opacity: '1' });
}

/** A figure that changed: the new value rolls in from the direction it moved. */
export function roll(el, up) {
  if (still || !el) return;
  g.fromTo(el, { yPercent: up ? 55 : -55, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.3, ease: 'power2.out', clearProps: 'transform,opacity' });
}
