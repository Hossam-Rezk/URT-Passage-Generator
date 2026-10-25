// Renders the API's structured `figures` (tables and line/bar/scatter charts) as DOM nodes.
const COLORS = ['#2457c5', '#d4462e', '#1a8f4a', '#8e44ad'];
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, text) {
  const n = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderTable(f) {
  const t = el('table');
  t.append(el('caption', {}, f.title));
  const head = el('tr');
  f.columns.forEach((c) => head.append(el('th', {}, c)));
  t.append(el('thead')).append(head);
  const body = el('tbody');
  f.rows.forEach((r) => { const tr = el('tr'); r.forEach((v) => tr.append(el('td', {}, String(v)))); body.append(tr); });
  t.append(body);
  return t;
}

const niceTicks = (min, max, n = 5) => Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? +v.toFixed(1) : +v.toFixed(2));
const axisLabel = (a) => `${a.label}${a.unit ? ` (${a.unit})` : ''}`;

function renderChart(f) {
  const W = 600; const H = 320; const L = 64; const R = 16; const T = 16; const B = 52;
  const pts = f.series.flatMap((s) => s.points);
  const cats = f.xAxis.categories;
  const xs = pts.map((p) => p[0]);
  const [x0, x1] = cats ? [-0.5, cats.length - 0.5] : [Math.min(...xs), Math.max(...xs)];
  const ys = pts.map((p) => p[1]);
  const y0 = Math.min(0, ...ys);
  const y1 = (Math.max(...ys) || 1) * 1.08;
  const sx = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const sy = (y) => H - B - ((y - y0) / (y1 - y0 || 1)) * (H - T - B);
  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': f.title });
  for (const y of niceTicks(y0, y1)) {
    svg.append(el('svg:line', { x1: L, x2: W - R, y1: sy(y), y2: sy(y), stroke: 'currentColor', 'stroke-opacity': 0.12 }));
    svg.append(el('svg:text', { x: L - 6, y: sy(y) + 4, 'text-anchor': 'end' }, fmt(y)));
  }
  if (cats) cats.forEach((c, i) => svg.append(el('svg:text', { x: sx(i), y: H - B + 16, 'text-anchor': 'middle' }, c)));
  else for (const x of niceTicks(x0, x1)) svg.append(el('svg:text', { x: sx(x), y: H - B + 16, 'text-anchor': 'middle' }, fmt(x)));
  svg.append(el('svg:line', { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: 'currentColor', 'stroke-opacity': 0.6 }));
  svg.append(el('svg:line', { x1: L, x2: L, y1: T, y2: H - B, stroke: 'currentColor', 'stroke-opacity': 0.6 }));
  const bw = cats ? (((W - L - R) / cats.length) * 0.7) / f.series.length : 0;
  f.series.forEach((s, si) => {
    const col = COLORS[si % COLORS.length];
    if (f.kind === 'bar_chart') {
      s.points.forEach(([x, y]) => svg.append(el('svg:rect', { x: sx(x) - (bw * f.series.length) / 2 + si * bw, y: sy(y),
        width: bw, height: Math.max(0, sy(y0) - sy(y)), fill: col })));
      return;
    }
    if (f.kind === 'line_chart') {
      svg.append(el('svg:polyline', { fill: 'none', stroke: col, 'stroke-width': 2,
        points: s.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ') }));
    }
    s.points.forEach(([x, y]) => svg.append(el('svg:circle', { cx: sx(x), cy: sy(y), r: 3.5, fill: col })));
  });
  svg.append(el('svg:text', { x: (L + W - R) / 2, y: H - 10, 'text-anchor': 'middle', 'font-size': 12 }, axisLabel(f.xAxis)));
  svg.append(el('svg:text', { transform: `translate(16 ${(T + H - B) / 2}) rotate(-90)`, 'text-anchor': 'middle', 'font-size': 12 },
    axisLabel(f.yAxis)));
  const fig = el('figure');
  fig.append(el('figcaption', {}, f.title), svg);
  const legend = el('div', { class: 'legend' });
  f.series.forEach((s, i) => { const span = el('span'); span.append(el('i', { style: `background:${COLORS[i % COLORS.length]}` }), s.name); legend.append(span); });
  fig.append(legend);
  if (f.caption) fig.append(el('p', { class: 'muted' }, f.caption));
  return fig;
}

export function renderFigure(f) {
  return f.kind === 'table' ? renderTable(f) : renderChart(f);
}
