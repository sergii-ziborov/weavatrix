(() => {
  const host = document.getElementById('net')
  if (!host) return

  const NS = 'http://www.w3.org/2000/svg'
  const nodes = [
    {id: 'app', label: 'application', x: 260, y: 218, r: 9, phase: .2, anchor: true},
    {id: 'mcp', label: 'mcp', x: 142, y: 122, r: 7, phase: 1.1},
    {id: 'analysis', label: 'analysis', x: 282, y: 78, r: 8, phase: 2.4},
    {id: 'graph', label: 'graph', x: 414, y: 142, r: 7, phase: 3.2},
    {id: 'security', label: 'security', x: 425, y: 292, r: 6, phase: 4.5},
    {id: 'precision', label: 'precision', x: 300, y: 370, r: 6, phase: 5.4},
    {id: 'scan', label: 'scan', x: 146, y: 338, r: 6, phase: 1.9},
    {id: 'infra', label: 'infra', x: 74, y: 236, r: 5, phase: 3.8},
    {id: 'route', x: 196, y: 52, r: 3.2, phase: 4.2},
    {id: 'contract', x: 482, y: 222, r: 3.2, phase: 1.5},
    {id: 'parser', x: 202, y: 407, r: 3.2, phase: 2.8},
    {id: 'history', x: 480, y: 356, r: 3.2, phase: 5.9},
  ]
  const edges = [
    ['app', 'mcp', -18], ['app', 'analysis', 14], ['app', 'graph', -14],
    ['app', 'security', 18, 'type'], ['app', 'precision', -12], ['app', 'scan', 15],
    ['app', 'infra', -16], ['mcp', 'analysis', -10], ['analysis', 'graph', 12],
    ['graph', 'security', -10], ['security', 'precision', 13, 'type'], ['precision', 'scan', -12],
    ['scan', 'infra', 10], ['route', 'mcp', 8, 'type'], ['graph', 'contract', -8],
    ['parser', 'precision', 9], ['security', 'history', -9, 'type'],
  ].map(([from, to, bend, kind = 'runtime'], index) => ({from, to, bend, kind, index}))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const adjacency = new Map(nodes.map((node) => [node.id, []]))
  edges.forEach((edge) => {
    adjacency.get(edge.from).push(edge.to)
    adjacency.get(edge.to).push(edge.from)
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
    <linearGradient id="hg-impact" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#b7aaff"/><stop offset="1" stop-color="#40e0c8"/></linearGradient>
    <filter id="hg-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
  svg.append(defs)
  svg.append(element('ellipse', {class: 'hg-atmosphere', cx: 286, cy: 222, rx: 250, ry: 205}))
  svg.append(element('ellipse', {class: 'hg-cluster', cx: 281, cy: 220, rx: 176, ry: 142}))
  svg.append(element('ellipse', {class: 'hg-cluster', cx: 281, cy: 220, rx: 112, ry: 88}))

  const edgeLayer = element('g')
  const impactLayer = element('g')
  const edgeViews = edges.map((edge) => {
    const base = element('path', {class: `hg-edge ${edge.kind === 'type' ? 'type' : ''}`})
    const impact = element('path', {class: 'hg-impact'})
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

  const sources = ['analysis', 'security', 'mcp']
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let animationFrame = 0
  let startedAt = performance.now()

  function render(now, staticFrame = false) {
    const positions = new Map(nodes.map((node) => [node.id, position(node, staticFrame ? 0 : now)]))
    const intro = staticFrame ? 1 : Math.min(1, (now - startedAt) / 1900)
    const cycle = staticFrame ? 3400 : Math.max(0, now - startedAt - 1500) % 7200
    const sourceIndex = staticFrame ? 0 : Math.floor(Math.max(0, now - startedAt - 1500) / 7200) % sources.length
    const source = sources[sourceIndex]
    const depth = distances(source)
    const wave = Math.max(-.7, Math.min(4.2, (cycle - 900) / 760))

    edges.forEach((edge, index) => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      const path = curve(from, to, edge.bend)
      const reveal = Math.max(0, Math.min(1, intro * 1.35 - index * .035))
      const edgeDepth = Math.min(depth.get(edge.from), depth.get(edge.to))
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
      const selected = node.id === source && cycle > 520 && cycle < 2100
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
