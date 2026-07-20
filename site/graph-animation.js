(() => {
  const host = document.getElementById('net')
  if (!host) return

  const NS = 'http://www.w3.org/2000/svg'
  const nodes = [
    {id: 'graph', label: 'src/graph · changed', x: 462, y: 220, r: 9, phase: .2, anchor: true},
    {id: 'analysis', label: 'src/analysis', x: 326, y: 82, r: 8, phase: 2.4},
    {id: 'mcp', label: 'src/mcp', x: 320, y: 172, r: 7, phase: 1.1},
    {id: 'src', label: 'src', x: 330, y: 272, r: 8, phase: 3.2},
    {id: 'precision', label: 'src/precision', x: 334, y: 368, r: 6, phase: 5.4},
    {id: 'extension', label: 'src/extension', x: 178, y: 142, r: 6, phase: 4.5},
    {id: 'security', label: 'src/security', x: 172, y: 232, r: 6, phase: 1.9},
    {id: 'scripts', label: 'scripts', x: 116, y: 72, r: 5, phase: 3.8},
    {id: 'scan', label: 'src/scan', x: 180, y: 328, r: 6, phase: 4.2},
    {id: 'infra', label: 'src/infra', x: 72, y: 384, r: 5, phase: 1.5},
  ]
  const edges = [
    ['graph', 'analysis', 18], ['graph', 'mcp', 9], ['graph', 'src', -9],
    ['graph', 'precision', -18], ['graph', 'extension', 34],
    ['analysis', 'security', 13], ['analysis', 'scripts', 19], ['analysis', 'mcp', -8],
    ['src', 'scan', -12], ['src', 'infra', -26], ['src', 'security', 12],
    ['src', 'precision', 8], ['mcp', 'extension', -10],
    ['security', 'extension', 8], ['scan', 'security', -9], ['infra', 'scan', 8],
  ].map(([from, to, bend, kind = 'runtime'], index) => ({from, to, bend, kind, index}))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const adjacency = new Map(nodes.map((node) => [node.id, []]))
  edges.forEach((edge) => {
    adjacency.get(edge.from).push(edge.to)
  })

  function element(name, attributes = {}) {
    const node = document.createElementNS(NS, name)
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
    return node
  }

  function position(node, time) {
    return {
      x: node.x + Math.sin(time * .00042 + node.phase) * 2.2,
      y: node.y + Math.cos(time * .00037 + node.phase * 1.7) * 2,
    }
  }

  function curve(from, to, bend) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    const middle = {
      x: (from.x + to.x) / 2 - (dy / length) * bend,
      y: (from.y + to.y) / 2 + (dx / length) * bend,
    }
    return {d: `M ${from.x} ${from.y} Q ${middle.x} ${middle.y} ${to.x} ${to.y}`, middle}
  }

  function pointOnCurve(from, middle, to, progress) {
    const inverse = 1 - progress
    return {
      x: inverse * inverse * from.x + 2 * inverse * progress * middle.x + progress * progress * to.x,
      y: inverse * inverse * from.y + 2 * inverse * progress * middle.y + progress * progress * to.y,
    }
  }

  function distances(source) {
    const result = new Map([[source, 0]])
    const queue = [source]
    for (const current of queue) {
      for (const next of adjacency.get(current)) {
        if (result.has(next)) continue
        result.set(next, result.get(current) + 1)
        queue.push(next)
      }
    }
    return result
  }

  const svg = element('svg', {viewBox: '0 0 540 440', preserveAspectRatio: 'xMidYMid meet'})
  const defs = element('defs')
  defs.innerHTML = `
    <radialGradient id="hg-atmosphere"><stop offset="0" stop-color="#5d4fd1" stop-opacity=".16"/><stop offset="1" stop-color="#0b0d14" stop-opacity="0"/></radialGradient>
    <linearGradient id="hg-impact" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#b7aaff"/><stop offset="1" stop-color="#40e0c8"/></linearGradient>
    <marker id="hg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke="#7768ed" stroke-width="1.2"/></marker>
    <marker id="hg-arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke="#79f0dc" stroke-width="1.4"/></marker>
    <filter id="hg-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
  svg.append(defs)
  svg.append(element('ellipse', {class: 'hg-atmosphere', cx: 300, cy: 222, rx: 270, ry: 205}))

  // Ambient "building-graph" field behind the hero graph: deterministic drifting motes on a
  // golden-ratio lattice that periodically link up, echoing the graph the tool assembles.
  const motes = Array.from({length: 16}, (_, i) => ({
    bx: 44 + ((i * 0.61803398) % 1) * 462,
    by: 26 + ((i * 0.75487766) % 1) * 388,
    sp: 0.00016 + (i % 5) * 0.000045,
    ph: i * 1.37,
  }))
  const moteLinks = []
  for (let a = 0; a < motes.length; a++) for (let b = a + 1; b < motes.length; b++) {
    if (Math.hypot(motes[a].bx - motes[b].bx, motes[a].by - motes[b].by) < 118) moteLinks.push({a, b, ph: (a * 3 + b) * 0.6})
  }
  const moteLayer = element('g', {class: 'hg-motes'})
  const moteLinkViews = moteLinks.map(() => { const line = element('line', {class: 'hg-mote-link'}); moteLayer.append(line); return line })
  const moteDots = motes.map(() => { const dot = element('circle', {class: 'hg-mote', r: 1.5}); moteLayer.append(dot); return dot })
  svg.append(moteLayer)

  const edgeLayer = element('g')
  const impactLayer = element('g')
  const edgeViews = edges.map((edge) => {
    const base = element('path', {class: `hg-edge ${edge.kind === 'type' ? 'type' : ''}`, 'marker-end': 'url(#hg-arrow)'})
    const impact = element('path', {class: 'hg-impact', 'marker-end': 'url(#hg-arrow-hot)'})
    edgeLayer.append(base)
    impactLayer.append(impact)
    return {base, impact}
  })
  svg.append(edgeLayer, impactLayer)

  const nodeLayer = element('g')
  const nodeViews = new Map(nodes.map((node) => {
    const group = element('g', {class: `hg-node ${node.anchor ? 'hg-node-anchor' : ''}`})
    group.append(element('circle', {class: 'hg-node-halo', r: node.r + 8}))
    group.append(element('circle', {class: 'hg-node-core', r: node.r}))
    if (node.label) {
      const label = element('text', {class: 'hg-node-label', x: 0, y: node.r + 17, 'text-anchor': 'middle'})
      label.textContent = node.label
      group.append(label)
    }
    nodeLayer.append(group)
    return [node.id, group]
  }))
  const packets = Array.from({length: 5}, () => {
    const packet = element('circle', {class: 'hg-packet', r: 3})
    svg.append(packet)
    return packet
  })
  svg.append(nodeLayer)
  host.replaceChildren(svg)

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let animationFrame = 0
  let startedAt = performance.now()

  function render(now, staticFrame = false) {
    const positions = new Map(nodes.map((node) => [node.id, position(node, staticFrame ? 0 : now)]))
    const intro = staticFrame ? 1 : Math.min(1, (now - startedAt) / 1900)
    const cycle = staticFrame ? 3400 : Math.max(0, now - startedAt - 1200) % 6800
    const source = 'graph'
    const depth = distances(source)
    const wave = Math.max(-.7, Math.min(4.2, (cycle - 900) / 760))

    edges.forEach((edge, index) => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      const path = curve(from, to, edge.bend)
      const reveal = Math.max(0, Math.min(1, intro * 1.35 - index * .035))
      const edgeDepth = depth.get(edge.from)
      const active = Math.max(0, 1 - Math.abs(wave - edgeDepth - .55) / .8)
      const {base, impact} = edgeViews[index]
      base.setAttribute('d', path.d)
      base.style.opacity = String((edge.kind === 'type' ? .4 : .33) * reveal)
      base.style.strokeDasharray = edge.kind === 'type' ? '4 7' : '1'
      impact.setAttribute('d', path.d)
      impact.style.opacity = String(active * .9)
      impact.style.strokeDasharray = '7 16'
      impact.style.strokeDashoffset = String(-(now * .045 + index * 9))
      edge.path = path
      edge.fromPosition = from
      edge.toPosition = to
      edge.active = active
    })

    nodes.forEach((node, index) => {
      const group = nodeViews.get(node.id)
      const nodeDepth = depth.get(node.id)
      const hit = Math.max(0, 1 - Math.abs(wave - nodeDepth) / .48)
      const visible = Math.max(0, Math.min(1, intro * 1.5 - index * .055))
      const selected = node.id === source && cycle > 360 && cycle < 2400
      const scale = .72 + visible * .28 + hit * .34 + (selected ? .16 : 0)
      const current = positions.get(node.id)
      group.setAttribute('transform', `translate(${current.x} ${current.y}) scale(${scale})`)
      group.style.opacity = String(visible)
      group.classList.toggle('hg-node-source', selected)
      group.classList.toggle('hg-node-hit', hit > .18 && !selected)
    })

    const activeEdges = edges.filter((edge) => edge.active > .12).sort((a, b) => b.active - a.active)
    packets.forEach((packet, index) => {
      const edge = activeEdges[index]
      if (!edge) {
        packet.style.opacity = '0'
        return
      }
      const progress = (now * .00048 + index * .19) % 1
      const point = pointOnCurve(edge.fromPosition, edge.path.middle, edge.toPosition, progress)
      packet.setAttribute('cx', point.x)
      packet.setAttribute('cy', point.y)
      packet.style.opacity = String(Math.min(.95, edge.active))
    })

    const moteTime = staticFrame ? 1400 : now
    motes.forEach((mote, index) => {
      mote.x = mote.bx + Math.sin(moteTime * mote.sp + mote.ph) * 10
      mote.y = mote.by + Math.cos(moteTime * mote.sp * .82 + mote.ph * 1.3) * 8
      const dot = moteDots[index]
      dot.setAttribute('cx', mote.x)
      dot.setAttribute('cy', mote.y)
      dot.style.opacity = String((.16 + (Math.sin(moteTime * .0006 + mote.ph) * .5 + .5) * .3) * intro)
    })
    moteLinks.forEach((link, index) => {
      const a = motes[link.a], b = motes[link.b]
      const line = moteLinkViews[index]
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y)
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y)
      const pulse = Math.max(0, Math.sin(moteTime * .00035 + link.ph))
      line.style.opacity = String(pulse * pulse * .2 * intro)
    })
  }

  function tick(now) {
    render(now)
    animationFrame = requestAnimationFrame(tick)
  }

  function restart() {
    cancelAnimationFrame(animationFrame)
    startedAt = performance.now()
    if (reducedMotion.matches) render(0, true)
    else animationFrame = requestAnimationFrame(tick)
  }

  reducedMotion.addEventListener?.('change', restart)
  restart()
})()
