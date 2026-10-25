// Renders generated sample passages (../data/urt_samples/*.json) as one HTML page for review.
//   node scripts/urt/renderSamples.js [--dir ../data/urt_samples] [--out ../data/urt_samples/index.html]
// Local review aid only; the student-facing client renders `figures` itself (INTEGRATION.md).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fleschKincaid } from '../../services/urt/agents/readability.js';
import { parseArgs } from './runtime.js';

const args = parseArgs(process.argv.slice(2));
const dir = path.resolve(args.dir ?? '../data/urt_samples');
const out = path.resolve(args.out ?? path.join(dir, 'index.html'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea'];

function table(f) {
  return `<table><caption>${esc(f.title)}</caption><thead><tr>${f.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
    + `<tbody>${f.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function chart(f) {
  const W = 520; const H = 300; const L = 60; const R = 20; const T = 20; const B = 50;
  const pts = f.series.flatMap((s) => s.points);
  const cats = f.xAxis.categories;
  const [x0, x1] = cats ? [-0.5, cats.length - 0.5] : [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const y0 = Math.min(0, ...pts.map((p) => p[1]));
  const y1 = Math.max(...pts.map((p) => p[1])) * 1.1 || 1;
  const sx = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const sy = (y) => H - B - ((y - y0) / (y1 - y0 || 1)) * (H - T - B);
  const ticks = (a, b, n = 5) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(2));
  let g = `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#555"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#555"/>`;
  for (const y of ticks(y0, y1)) g += `<text x="${L - 6}" y="${sy(y) + 4}" text-anchor="end">${fmt(y)}</text><line x1="${L}" x2="${W - R}" y1="${sy(y)}" y2="${sy(y)}" stroke="#eee"/>`;
  if (cats) cats.forEach((c, i) => { g += `<text x="${sx(i)}" y="${H - B + 16}" text-anchor="middle">${esc(c)}</text>`; });
  else for (const x of ticks(x0, x1)) g += `<text x="${sx(x)}" y="${H - B + 16}" text-anchor="middle">${fmt(x)}</text>`;
  const bw = cats ? ((W - L - R) / cats.length) * 0.7 / f.series.length : 0;
  f.series.forEach((s, si) => {
    const col = COLORS[si % COLORS.length];
    if (f.kind === 'bar_chart') {
      for (const [x, y] of s.points) {
        const left = sx(x) - (bw * f.series.length) / 2 + si * bw;
        g += `<rect x="${left}" y="${sy(y)}" width="${bw}" height="${sy(y0) - sy(y)}" fill="${col}"/>`;
      }
    } else {
      if (f.kind === 'line_chart') g += `<polyline fill="none" stroke="${col}" stroke-width="2" points="${s.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ')}"/>`;
      for (const [x, y] of s.points) g += `<circle cx="${sx(x)}" cy="${sy(y)}" r="3" fill="${col}"/>`;
    }
  });
  const unit = (a) => `${esc(a.label)}${a.unit ? ` (${esc(a.unit)})` : ''}`;
  g += `<text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle" class="ax">${unit(f.xAxis)}</text>`
    + `<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="ax">${unit(f.yAxis)}</text>`;
  const legend = f.series.map((s, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(s.name)}</span>`).join('');
  return `<figure><figcaption>${esc(f.title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg><div class="legend">${legend}</div></figure>`;
}

function passage(file) {
  const r = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  if (!r.draft) return `<section><h2>${esc(file)}</h2><p class="bad">No passing draft (${r.attempts.length} attempts).</p></section>`;
  const { combination: c, draft: d, validation: v } = r;
  const fk = fleschKincaid(d.body.join(' '));
  const minor = v.report.reasons.filter((x) => x.includes('(minor)'));
  const qs = d.questions.map((q) => `<li><p>${esc(q.stem)}${q.figureRef ? ` <span class="tag">${esc(q.figureRef)}</span>` : ''}</p><ol type="A">${q.options.map((o) => `<li class="${o.label === q.correctAnswer ? 'key' : ''}">${esc(o.text)}</li>`).join('')}</ol>`
    + `<details><summary>Why the other options are wrong</summary><ul>${q.distractorRationale.map((x) => `<li><b>${esc(x.label)}</b> (${esc(x.pattern)}): ${esc(x.whyWrong)}</li>`).join('')}</ul></details></li>`).join('');
  return `<section>
  <div class="meta"><b>${esc(c.subject)}</b> · ${esc(c.topicId)} / ${esc(c.subtopicId)} · ${esc(c.styleId)} · ${esc(c.difficulty)}
    · ${fk.words} words · FK grade ${fk.grade} · ${r.attempts.length} attempt(s) · $${(r.costUsd ?? 0).toFixed(4)}</div>
  <h2>${esc(d.title)}</h2>
  ${d.body.map((p) => `<p>${esc(p)}</p>`).join('')}
  ${d.figures.map((f) => (f.kind === 'table' ? table(f) : chart(f))).join('')}
  <h3>Questions <small>(correct answer highlighted)</small></h3><ol class="qs">${qs}</ol>
  <div class="verdict"><b>Validator:</b> passed. Originality ${esc(JSON.stringify(v.originality?.scores ?? {}))}.
    ${minor.length ? `Minor: ${minor.map(esc).join('; ')}.` : 'No minor issues.'}<br><b>Review:</b> ${esc(v.review?.summary ?? '')}
    ${r.attempts.length > 1 ? `<br><b>Earlier attempts rejected:</b> ${r.attempts.slice(0, -1).map((a) => esc(a.reasons.slice(0, 3).join('; '))).join(' / ')}` : ''}</div>
</section>`;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>URT Sample Passages</title><style>
:root{--fg:#1f2328;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--key:#dafbe1;--card:#f6f8fa}
@media (prefers-color-scheme: dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--key:#1f4a2c;--card:#151b23}}
body{background:var(--bg);color:var(--fg);font:16px/1.6 Georgia,serif;max-width:820px;margin:0 auto;padding:16px}
section{border-top:3px solid var(--line);padding:24px 0}h2{margin:.2em 0}.meta{font:13px system-ui;color:var(--muted)}
table{border-collapse:collapse;margin:16px 0;font:14px system-ui}caption{font-weight:600;text-align:left;padding:4px 0}
th,td{border:1px solid var(--line);padding:4px 10px;text-align:center}figure{margin:16px 0}figcaption{font:600 14px system-ui}
svg{width:100%;max-width:560px;font:11px system-ui;fill:var(--fg)}.ax{font-size:12px}.legend{font:13px system-ui;display:flex;gap:16px;flex-wrap:wrap}
.legend i{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-1px}
.qs>li{margin-bottom:14px}.qs ol li{padding:1px 6px}.key{background:var(--key);font-weight:600;border-radius:4px}
.tag{font:12px system-ui;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 6px}
details{font:13px system-ui;color:var(--muted)}.verdict{font:13px/1.5 system-ui;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;margin-top:12px}
.bad{color:#cf222e}</style></head><body><h1>URT sample passages</h1>
<p class="meta">${files.length} generated sample(s). Generated by the M6 pipeline; review aid only.</p>
${files.map(passage).join('\n')}</body></html>`;
writeFileSync(out, html);
console.log(`wrote ${out}`);
