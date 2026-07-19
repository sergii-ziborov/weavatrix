(() => {
  const cv = document.getElementById('net'), cx = cv.getContext('2d');
  let W, H, nodes = [], links = [];
  const N = 46, LINKDIST = 150;

  function reset() {
    const r = cv.parentElement.getBoundingClientRect();
    W = cv.width = r.width * devicePixelRatio; H = cv.height = r.height * devicePixelRatio;
    nodes = Array.from({length: N}, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .18 * devicePixelRatio, vy: (Math.random() - .5) * .18 * devicePixelRatio,
      r: (Math.random() * 2.2 + 1.4) * devicePixelRatio,
    }));
    links = [];
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < LINKDIST * devicePixelRatio && Math.random() < .5) links.push([i, j]);
    }
  }

  let pulse = 0, pulseNode = 0;
  function tick(t) {
    cx.clearRect(0, 0, W, H);
    // one node "changes" every few seconds and its blast radius ripples out
    if (t / 1600 > pulse) { pulse = Math.ceil(t / 1600); pulseNode = Math.floor(Math.random() * N); }
    const ripple = ((t % 1600) / 1600) * 130 * devicePixelRatio;
    const pn = nodes[pulseNode];

    cx.lineWidth = devicePixelRatio * .7;
    for (const [i, j] of links) {
      const a = nodes[i], b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > LINKDIST * 1.6 * devicePixelRatio) continue;
      const near = Math.min(Math.hypot(a.x - pn.x, a.y - pn.y), Math.hypot(b.x - pn.x, b.y - pn.y));
      const hot = Math.abs(near - ripple) < 34 * devicePixelRatio;
      cx.strokeStyle = hot ? 'rgba(64,224,200,.5)' : 'rgba(124,108,255,.14)';
      cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke();
    }
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
      const dp = Math.hypot(n.x - pn.x, n.y - pn.y);
      const hot = i === pulseNode || Math.abs(dp - ripple) < 30 * devicePixelRatio;
      cx.fillStyle = i === pulseNode ? '#40e0c8' : hot ? 'rgba(64,224,200,.85)' : 'rgba(160,150,255,.5)';
      cx.beginPath(); cx.arc(n.x, n.y, i === pulseNode ? n.r * 1.7 : n.r, 0, 7); cx.fill();
    }
    requestAnimationFrame(tick);
  }
  addEventListener('resize', reset);
  reset(); requestAnimationFrame(tick);
})();
