// The background's pixel blocks, after the supplied banner: a fine grid of grey squares, empty in
// the middle, gathered in patches toward the sides, plus larger brighter blocks near the edges.
// Motion:
//   - a slow wave of brightness rolls outward from the centre through the fine grid
//   - the large blocks are born, glow and fade, then reappear somewhere else near the edges
//   - blocks near the cursor light up
// Strength per view: full on the homepage, faint beside the forms, off in the terminal (the loop
// stops entirely at 0). Reduced motion draws one still frame.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const smooth = (x, y, s) => {
  const gx = x / s, gy = y / s, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

export function startPixels(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, level = 1, shown = 1, raf = 0, last = 0;
  let dots = new Float32Array(0); // x, y, alpha, distance from centre
  let big = [];
  const ptr = { x: -9999, y: -9999 };

  // 0 in the middle of the screen, 1 at the side edges; the right side runs a little stronger
  const edge = (x, y) => {
    const nx = x / W, ny = y / H;
    const side = nx < 0.5 ? (0.5 - nx) / 0.5 : ((nx - 0.5) / 0.5) * 1.08;
    return Math.min(1, Math.max(0, (side + Math.abs(ny - 0.5) * 0.35 - 0.42) / 0.58));
  };

  const spawn = (b, s, first) => {
    // rejection-sample a spot weighted toward the edges, snapped to a 9px grid
    for (let i = 0; i < 40; i += 1) {
      const x = Math.random() * W, y = Math.random() * H, e = edge(x, y);
      if (Math.random() < Math.pow(e, 2.2)) {
        b.x = Math.round(x / 9) * 9;
        b.y = Math.round(y / 9) * 9;
        b.e = e;
        break;
      }
    }
    b.sz = Math.random() < 0.2 ? 9 + ((Math.random() * 7) | 0) : 4 + ((Math.random() * 3) | 0);
    b.peak = 0.16 + b.e * 0.36 * (0.4 + Math.random() * 0.6);
    b.life = 3 + Math.random() * 6;
    b.born = first ? s - Math.random() * b.life : s + Math.random() * 1.5;
  };

  function build(s) {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth;
    H = innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const list = [];
    const P = 9;
    for (let y = 0; y < H; y += P) {
      for (let x = 0; x < W; x += P) {
        const e = edge(x, y);
        if (e <= 0) continue;
        const patch = smooth(x, y, 140) * 0.75 + smooth(x + 999, y, 46) * 0.45;
        const a = Math.pow(e, 1.5) * Math.max(0, patch - 0.38) * 0.6;
        if (a < 0.02 || hash(x, y) > 0.55 + e * 0.4) continue;
        list.push(x, y, a, Math.hypot(x - W / 2, (y - H / 2) * 1.4));
      }
    }
    dots = Float32Array.from(list);
    const n = Math.round((W * H) / 16000);
    big = Array.from({ length: n }, () => {
      const b = {};
      spawn(b, s, true);
      return b;
    });
  }

  function draw(t) {
    const s = t / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    shown += (level - shown) * 0.06;
    if (shown < 0.01) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    const R = 170;
    // fine grid with the outward wave and the cursor glow
    for (let i = 0; i < dots.length; i += 4) {
      const x = dots[i], y = dots[i + 1];
      const wave = reduce ? 0.6 : 0.5 + 0.5 * Math.sin(s * 1.1 - dots[i + 3] * 0.012);
      let a = dots[i + 2] * (0.35 + 0.95 * wave * wave);
      const dx = x - ptr.x, dy = y - ptr.y;
      if (dx * dx + dy * dy < R * R) a += (1 - Math.sqrt(dx * dx + dy * dy) / R) ** 2 * 0.45;
      if (a < 0.015) continue;
      ctx.globalAlpha = Math.min(1, a) * shown;
      ctx.fillRect(x, y, 2, 2);
    }
    // large blocks: born, glow, fade, reborn elsewhere
    for (const b of big) {
      let age = s - b.born;
      if (!reduce && age > b.life) {
        spawn(b, s, false);
        age = s - b.born;
      }
      if (age < 0) continue;
      const fade = reduce ? 1 : Math.min(1, age / 1.2, (b.life - age) / 1.2);
      const dx = b.x - ptr.x, dy = b.y - ptr.y;
      const near = dx * dx + dy * dy < R * R ? (1 - Math.sqrt(dx * dx + dy * dy) / R) * 0.4 : 0;
      ctx.globalAlpha = Math.min(1, Math.max(0, b.peak * fade + near)) * shown;
      ctx.fillRect(b.x, b.y, b.sz, b.sz);
    }
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    raf = 0;
    if (t - last >= 33) { // ~30 fps is plenty for a background
      last = t;
      draw(t);
    }
    if (!reduce && !document.hidden && (level > 0 || shown > 0.01)) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { build(performance.now() / 1000); kick(); }, 150); });
  addEventListener('pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; }, { passive: true });
  document.addEventListener('pointerleave', () => { ptr.x = ptr.y = -9999; });
  document.addEventListener('visibilitychange', kick);
  build(performance.now() / 1000);
  kick();
  return {
    set strength(v) {
      level = v;
      if (reduce) {
        shown = v;
        requestAnimationFrame(draw);
      }
      kick();
    },
  };
}
