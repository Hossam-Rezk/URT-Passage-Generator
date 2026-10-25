// URT practice page: subject → passage → answers → result with explanations.
// Follows the client steps in INTEGRATION.md (202 + polling, resume by servingId, 409 handling).
import { renderFigure } from './figures.js';

const $ = (id) => document.getElementById(id);
const store = {
  get user() { try { return JSON.parse(localStorage.getItem('urt.user')); } catch { return null; } },
  set user(v) { try { v ? localStorage.setItem('urt.user', JSON.stringify(v)) : localStorage.removeItem('urt.user'); } catch { /* private mode */ } },
  get serving() { try { return localStorage.getItem(`urt.serving.${this.user?.id}`); } catch { return null; } },
  set serving(v) { try { v ? localStorage.setItem(`urt.serving.${this.user?.id}`, v) : localStorage.removeItem(`urt.serving.${this.user?.id}`); } catch { /* ignore */ } },
};
let current = null; // the serving shown
let currentSubject = null;

function show(...ids) {
  for (const s of ['pick', 'waiting', 'message', 'passage', 'admin']) $(s).hidden = !ids.includes(s);
}

async function api(method, path, body) {
  const u = store.user;
  const res = await fetch(`/api/urt${path}`, { method, headers: { 'content-type': 'application/json',
    'x-dev-user': `${u.id}:${u.admin ? 'admin' : 'student'}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, retryAfter: Number(res.headers.get('retry-after') ?? 0) };
}

function message(text) {
  $('messageText').textContent = text;
  show('message');
}

// ------------------------------------------------------------------------------------ login
function renderLogin() {
  const u = store.user;
  $('login').hidden = Boolean(u);
  $('who').hidden = !u;
  if (!u) return show();
  $('whoText').textContent = `Student ${u.id}${u.admin ? ' (admin)' : ''}`;
  return loadSubjects();
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  store.user = { id: Number($('userId').value), admin: $('asAdmin').checked };
  renderLogin();
});
$('logout').addEventListener('click', () => { store.user = null; renderLogin(); });

// ------------------------------------------------------------------------------------ subjects
async function loadSubjects() {
  const { status, data } = await api('GET', '/subjects');
  if (status !== 200) return message(data.error?.message ?? `Could not load subjects (${status})`);
  const box = $('subjects');
  box.replaceChildren(...data.subjects.map((s) => {
    const b = document.createElement('button');
    b.textContent = s;
    b.addEventListener('click', () => nextPassage(s));
    return b;
  }));
  $('resumeBox').hidden = !store.serving;
  show(...(store.user.admin ? ['pick', 'admin'] : ['pick']));
  if (store.user.admin) refreshStats();
  return null;
}
$('resume').addEventListener('click', async () => {
  const { status, data } = await api('GET', `/servings/${store.serving}`);
  if (status === 200) renderServing(data);
  else { store.serving = null; loadSubjects(); }
});
$('back').addEventListener('click', () => loadSubjects());

// ------------------------------------------------------------------------------------ next + polling
async function nextPassage(subject) {
  currentSubject = subject;
  show('waiting');
  $('waitText').textContent = 'Finding a passage…';
  let res = await api('POST', '/passages/next', { subject });
  while (res.status === 202) {
    $('waitText').textContent = `Writing a new ${subject} passage for you (${res.data.status})… this can take a minute.`;
    await new Promise((r) => { setTimeout(r, res.data.retryAfterMs ?? 3000); });
    res = await api('GET', `/jobs/${res.data.jobId}`);
  }
  if (res.status === 200) return renderServing(res.data);
  return message(res.data.error?.message ?? `Something went wrong (${res.status})`);
}

// ------------------------------------------------------------------------------------ rendering
function renderServing(s) {
  current = s;
  store.serving = s.result ? null : String(s.servingId);
  $('passageMeta').textContent = `${s.passage.subject} · passage #${s.passage.id} · serving #${s.servingId}`;
  $('title').textContent = s.passage.title;
  $('body').replaceChildren(...s.passage.body.split(/\n{2,}/).map((t) => Object.assign(document.createElement('p'), { textContent: t })));
  $('figures').replaceChildren(...(s.passage.figures ?? []).map(renderFigure));
  const form = $('questions');
  form.replaceChildren(...s.questions.map((q) => {
    const fs = document.createElement('fieldset');
    fs.className = 'q';
    fs.dataset.qid = q.id;
    const lg = document.createElement('legend');
    lg.textContent = `${q.orderIndex}. ${q.question}`;
    if (q.figureRef) lg.append(Object.assign(document.createElement('span'), { className: 'ref', textContent: `(uses ${q.figureRef.replace('fig', 'figure ')})` }));
    fs.append(lg);
    for (const o of q.options) {
      const label = document.createElement('label');
      label.className = 'opt';
      label.dataset.label = o.label;
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: `q${q.id}`, value: o.label });
      input.addEventListener('change', updateAnswered);
      label.append(input, Object.assign(document.createElement('span'), { className: 'lbl', textContent: o.label }),
        Object.assign(document.createElement('span'), { textContent: o.text }));
      fs.append(label);
    }
    return fs;
  }));
  $('result').hidden = true;
  $('next').hidden = true;
  $('submit').disabled = false;
  updateAnswered();
  show('passage');
  window.scrollTo({ top: 0 });
  if (s.result) renderResult(s.result);
}

function chosenAnswers() {
  return current.questions.map((q) => ({ questionId: q.id,
    answer: document.querySelector(`input[name="q${q.id}"]:checked`)?.value ?? null }));
}

function updateAnswered() {
  const n = chosenAnswers().filter((a) => a.answer).length;
  $('answered').textContent = `${n} of ${current.questions.length} answered${n < current.questions.length ? ' (blank ones count as wrong)' : ''}`;
}

$('questions').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('submit').disabled = true;
  const { status, data } = await api('POST', `/servings/${current.servingId}/submission`, { answers: chosenAnswers() });
  if (status === 200) return renderResult(data);
  if (status === 409) return renderResult(data.error.result);
  $('submit').disabled = false;
  return alert(data.error?.message ?? `Submission failed (${status})`);
});

function renderResult(result) {
  store.serving = null;
  const byQ = new Map(result.results.map((r) => [r.questionId, r]));
  const why = new Map(result.explanations.map((x) => [x.questionId, x.explanation]));
  for (const fs of document.querySelectorAll('.q')) {
    const r = byQ.get(Number(fs.dataset.qid));
    fs.querySelectorAll('input').forEach((i) => { i.disabled = true; i.checked = i.value === r.chosen; });
    fs.querySelectorAll('.opt').forEach((o) => {
      o.classList.toggle('correct', o.dataset.label === r.correctAnswer);
      o.classList.toggle('wrong', o.dataset.label === r.chosen && !r.isCorrect);
    });
    fs.querySelectorAll('.verdict, .explain').forEach((n) => n.remove());
    fs.append(Object.assign(document.createElement('div'), { className: `verdict ${r.isCorrect ? 'ok' : 'bad'}`,
      textContent: r.isCorrect ? 'Correct' : r.chosen ? `Incorrect — the answer is ${r.correctAnswer}` : `Not answered — the answer is ${r.correctAnswer}` }));
    if (why.has(r.questionId)) fs.append(Object.assign(document.createElement('div'), { className: 'explain', textContent: why.get(r.questionId) }));
  }
  const box = $('result');
  box.replaceChildren(Object.assign(document.createElement('div'), { className: 'score', textContent: `${result.score} / ${result.total}` }),
    Object.assign(document.createElement('p'), { className: 'muted', textContent: result.explanations.length
      ? 'Explanations are shown under each question you missed.' : result.score === result.total ? 'All correct!' : 'No explanations available right now.' }));
  box.hidden = false;
  $('submit').disabled = true;
  $('next').hidden = false;
}
$('next').addEventListener('click', () => (currentSubject ? nextPassage(currentSubject) : loadSubjects()));

// ------------------------------------------------------------------------------------ admin
async function refreshStats() {
  const { status, data } = await api('GET', '/admin/stats');
  $('stats').textContent = status === 200 ? JSON.stringify(data, null, 2) : `(${status}) ${data.error?.message ?? ''}`;
}
$('refreshStats').addEventListener('click', refreshStats);

fetch('/api/dev/info').then((r) => r.json()).then((i) => {
  $('mode').textContent = i.mode === 'live' ? 'live models' : 'offline';
}).catch(() => {});
renderLogin();
