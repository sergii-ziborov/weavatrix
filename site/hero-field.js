(() => {
  const host = document.getElementById('hero-field')
  if (!host) return
  const graph = document.getElementById('net')

  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Ambient "building-graph" field across the whole top band. A deterministic golden-ratio
  // lattice (no RNG) spreads motes evenly; they drift at varied speeds and link up by LIVE
  // proximity, so connections form and dissolve as they weave — a graph assembling itself.
  // The main hero graph gets an exclusion rect: motes are pushed out of it and no link is drawn
  // across it, so the field never builds behind the primary animation.
  const COUNT = 42
  const PHI = 0.6180339887, PSI = 0.7548776662
  const seeds = Array.from({length: COUNT}, (_, i) => ({
    u: (0.5 + i * PHI) % 1,
    v: (0.13 + i * PSI) % 1,
    sp: 0.045 + (i % 6) * 0.012,
    ph: i * 1.2399,
    ax: 0.04 + (i % 4) * 0.016,
    ay: 0.05 + (i % 3) * 0.02,
    tw: 0.55 + (i % 5) * 0.11,
    r: 1.3 + (i % 7 === 0 ? 1.4 : 0),
  }))
  const pts = Array.from({length: COUNT}, () => ({x: 0, y: 0, hidden: false, a: 0}))

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let W = 0, H = 0, minWH = 1, link = 160, ex = null
  let anchors = []
  let raf = 0, startedAt = 0, running = false

  function pushOut(x, y) {
    if (!ex || x < ex.l || x > ex.r || y < ex.t || y > ex.b) return [x, y]
    const dl = x - ex.l, dr = ex.r - x, dt = y - ex.t, db = ex.b - y
    const m = Math.min(dl, dr, dt, db)
    if (m === dl) return [ex.l - 36, y]
    if (m === dr) return [ex.r + 36, y]
    if (m === dt) return [x, ex.t - 36]
    return [x, ex.b + 36]
  }

  function layout() {
    const box = host.getBoundingClientRect()
    W = Math.max(1, box.width)
    H = Math.max(1, box.height)
    minWH = Math.min(W, H)
    link = Math.max(120, Math.min(205, W * 0.12))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ex = null
    if (graph) {
      const g = graph.getBoundingClientRect()
      if (g.width > 4 && g.height > 4) {
        const margin = 24
        // The main graph is mask-faded across its left ~40%; only guard its visible right side.
        const visibleLeft = g.left + g.width * 0.4
        ex = {
          l: Math.max(0, visibleLeft - box.left - margin),
          t: g.top - box.top - margin,
          r: g.right - box.left + margin,
          b: g.bottom - box.top + margin,
        }
      }
    }
    anchors = seeds.map((s) => {
      const [x, y] = pushOut(s.u * W, s.v * H)
      return {x, y}
    })
  }

  function inEx(x, y) {
    return !!ex && x >= ex.l && x <= ex.r && y >= ex.t && y <= ex.b
  }

  // Liang-Barsky: does the segment cross the exclusion rect at all?
  function segHitsEx(x1, y1, x2, y2) {
    if (!ex) return false
    let t0 = 0, t1 = 1
    const dx = x2 - x1, dy = y2 - y1
    const p = [-dx, dx, -dy, dy]
    const q = [x1 - ex.l, ex.r - x1, y1 - ex.t, ex.b - y1]
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false
      } else {
        const t = q[i] / p[i]
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t }
        else { if (t < t0) return false; if (t < t1) t1 = t }
      }
    }
    return true
  }

  function frame(now, staticFrame) {
    const t = staticFrame ? 2200 : now - startedAt
    const intro = staticFrame ? 1 : Math.min(1, t / 1700)
    ctx.clearRect(0, 0, W, H)

    for (let i = 0; i < COUNT; i++) {
      const s = seeds[i], a = anchors[i], P = pts[i]
      P.x = a.x + Math.sin(t * 0.001 * s.sp + s.ph) * s.ax * minWH
      P.y = a.y + Math.cos(t * 0.001 * s.sp * 0.83 + s.ph * 1.3) * s.ay * minWH
      const twinkle = 0.45 + (Math.sin(t * 0.0013 * s.tw + s.ph) * 0.5 + 0.5) * 0.55
      P.hidden = inEx(P.x, P.y)
      P.a = twinkle * intro
    }

    // Links by live proximity — closer motes glow brighter, so the graph keeps rebuilding itself.
    ctx.lineWidth = 0.9
    for (let i = 0; i < COUNT; i++) {
      const pi = pts[i]
      if (pi.hidden) continue
      for (let j = i + 1; j < COUNT; j++) {
        const pj = pts[j]
        if (pj.hidden) continue
        const dx = pi.x - pj.x, dy = pi.y - pj.y
        const d = Math.hypot(dx, dy)
        if (d >= link) continue
        if (segHitsEx(pi.x, pi.y, pj.x, pj.y)) continue
        const closeness = 1 - d / link
        const alpha = closeness * closeness * 0.5 * intro
        if (alpha < 0.012) continue
        ctx.strokeStyle = 'rgba(139,124,255,' + alpha.toFixed(3) + ')'
        ctx.beginPath()
        ctx.moveTo(pi.x, pi.y)
        ctx.lineTo(pj.x, pj.y)
        ctx.stroke()
      }
    }

    for (let i = 0; i < COUNT; i++) {
      const p = pts[i]
      if (p.hidden) continue
      const s = seeds[i]
      if (s.r > 1.9) {
        ctx.fillStyle = 'rgba(124,108,255,' + (p.a * 0.22).toFixed(3) + ')'
        ctx.beginPath()
        ctx.arc(p.x, p.y, s.r + 3.2, 0, 6.2831853)
        ctx.fill()
      }
      ctx.fillStyle = 'rgba(160,146,255,' + (p.a * 0.85).toFixed(3) + ')'
      ctx.beginPath()
      ctx.arc(p.x, p.y, s.r, 0, 6.2831853)
      ctx.fill()
    }
  }

  function tick(now) {
    frame(now, false)
    raf = requestAnimationFrame(tick)
  }

  function stop() {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  function start() {
    stop()
    layout()
    if (reducedMotion.matches) { frame(0, true); return }
    running = true
    startedAt = performance.now()
    raf = requestAnimationFrame(tick)
  }

  let resizeTimer = 0
  addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => { running ? layout() : start() }, 160)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else if (!reducedMotion.matches) start()
  })
  reducedMotion.addEventListener?.('change', start)
  start()
})()
