// Lexia — lógica de la app (vanilla JS, sin dependencias)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- Guard de sesión: sin login -> a /login.html ----------
(async () => {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) { location.href = '/login.html'; return; }
    const { user } = await r.json();
    const e = document.getElementById('user-email'); if (e) e.textContent = user.email;
    const d = document.getElementById('user-despacho'); if (d) d.textContent = `${user.despacho} · ${user.role}`;
  } catch { location.href = '/login.html'; }
})();
document.getElementById('logout')?.addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const renderCites = (t) => esc(t).replace(/\[(\d+)\]/g, '<span class="cite" data-n="$1">[$1]</span>');

// Renderizador Markdown ligero y SEGURO (escapa primero) + citas [n] clicables.
// Soporta encabezados, listas (•/-/1.), negrita, cursiva, código y párrafos.
function renderMD(text) {
  const inline = (x) => x
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<span class="cite" data-n="$1">[$1]</span>');
  const lines = esc(text).split('\n');
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { close(); const lv = Math.min(m[1].length + 2, 6); html += `<h${lv}>${inline(m[2])}</h${lv}>`; }
    else if ((m = line.match(/^\s*(?:[-*•]|–)\s+(.*)$/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return html;
}

// ---------- Navegación entre vistas ----------
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.side nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  if (name === 'biblioteca') loadLibrary();
  if (name === 'historial') renderHistory();
}
$$('.side nav a').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); location.hash = a.dataset.view; }));
window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'consulta'));
showView(location.hash.slice(1) || 'consulta');

// ---------- Fuentes (panel lateral) ----------
function renderSources(el, fuentes) {
  el.innerHTML = fuentes.map((f) => `
    <div class="src" id="src-${f.n}">
      <span class="score">sim ${f.score}</span>
      <span class="n">${f.n}</span>
      <div class="cita">${esc(f.cita)}</div>
      <div class="fuente">${esc(f.fuente)} · ${esc(f.materia)}</div>
      <a href="${f.url}" target="_blank" rel="noopener">Ver fuente oficial ↗</a>
    </div>`).join('');
}

// ---------- CONSULTA ----------
const chat = $('#chat');
const formC = $('#form-consulta');
const q = $('#q');

$$('#ex-chips button').forEach((b) =>
  b.addEventListener('click', () => { q.value = b.textContent; q.focus(); }));

function addBubble(cls, html) {
  const d = document.createElement('div');
  d.className = 'bubble ' + cls; d.innerHTML = html;
  chat.appendChild(d); chat.scrollTop = chat.scrollHeight;
  return d;
}

formC.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = q.value.trim(); if (!query) return;
  $('#chat-empty')?.remove();
  addBubble('user', esc(query));
  q.value = '';
  const btn = formC.querySelector('button'); btn.disabled = true;
  const bot = addBubble('bot', '<span class="typing">Lexia está consultando las fuentes…</span>');
  try {
    const r = await fetch('/api/consulta', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    bot.innerHTML = `<div class="md">${renderMD(d.answer)}</div>` +
      `<div class="meta">${d.model} · ${(d.ms / 1000).toFixed(1)}s · ${d.fuentes.length} fuentes</div>`;
    renderSources($('#sources'), d.fuentes);
    saveHistory(query, d.answer, d.fuentes);
  } catch (err) {
    bot.innerHTML = `<span class="msg-err">Error: ${err.message}</span>`;
  } finally { btn.disabled = false; }
});

chat.addEventListener('click', (e) => {
  if (e.target.classList.contains('cite')) {
    const el = $('#src-' + e.target.dataset.n);
    if (el) { el.scrollIntoView({ behavior: 'smooth' }); el.style.borderColor = 'var(--accent)'; setTimeout(() => el.style.borderColor = 'var(--line)', 1200); }
  }
});

// ---------- REDACCION ----------
const formR = $('#form-redaccion');
let lastDraft = '';
formR.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tipo = $('#tipo').value;
  const hechos = $('#hechos').value.trim();
  const instrucciones = $('#instrucciones').value.trim();
  if (!hechos) return;
  const btn = formR.querySelector('button[type=submit]'); btn.disabled = true;
  const out = $('#draft-out');
  out.innerHTML = '<div class="draft"><span class="typing">Redactando borrador con base normativa…</span></div>';
  try {
    const r = await fetch('/api/redactar', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tipo, hechos, instrucciones }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    lastDraft = d.draft;
    out.innerHTML = `<div class="draft md">${renderMD(d.draft)}</div>
      <p class="note" style="margin-top:8px">${d.model} · ${(d.ms / 1000).toFixed(1)}s · borrador asistido, revísalo antes de presentar.</p>`;
    renderSources($('#draft-sources'), d.fuentes);
    $('#copiar').style.display = 'inline-block';
  } catch (err) {
    out.innerHTML = `<p class="msg-err">Error: ${err.message}</p>`;
  } finally { btn.disabled = false; }
});
$('#copiar').addEventListener('click', () => {
  navigator.clipboard.writeText(lastDraft);
  $('#copiar').textContent = '✓ Copiado'; setTimeout(() => $('#copiar').textContent = 'Copiar', 1500);
});

// ---------- BIBLIOTECA (búsqueda en servidor sobre todo el corpus) ----------
let libTimer = null;
async function loadLibrary(q = '') {
  const r = await fetch('/api/fuentes?limit=80&q=' + encodeURIComponent(q));
  const d = await r.json();
  const head = `<p class="note" style="margin-bottom:14px">${d.total.toLocaleString('es-ES')} artículos en el corpus${q ? ` · ${d.total} coinciden con “${esc(q)}”` : ''} · mostrando ${d.mostrados}.</p>`;
  $('#lib-list').innerHTML = head + (d.fuentes.length ? d.fuentes.map((x) => `
    <div class="lib-item">
      <span class="tag">${esc(x.rango)} · ${esc(x.materia)}</span>
      <h4>${esc(x.cita)}</h4>
      <p>${esc(x.texto)}</p>
      <a href="${x.url}" target="_blank" rel="noopener">${esc(x.fuente)} — fuente oficial ↗</a>
    </div>`).join('') : '<p class="note">Sin resultados.</p>');
}
$('#lib-search').addEventListener('input', (e) => {
  clearTimeout(libTimer);
  libTimer = setTimeout(() => loadLibrary(e.target.value.trim()), 250);
});

// ---------- HISTORIAL (localStorage) ----------
const HKEY = 'lexia-historial';
function saveHistory(q, answer, fuentes) {
  const h = JSON.parse(localStorage.getItem(HKEY) || '[]');
  h.unshift({ q, answer, fuentes, fecha: new Date().toISOString() });
  localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 50)));
}
function renderHistory() {
  const h = JSON.parse(localStorage.getItem(HKEY) || '[]');
  $('#hist-list').innerHTML = h.length ? h.map((x, i) => `
    <div class="hist-item" data-i="${i}">
      <div class="q">${esc(x.q)}</div>
      <div class="d">${new Date(x.fecha).toLocaleString('es-ES')} · ${x.fuentes.length} fuentes</div>
    </div>`).join('') : '<p class="note">Aún no hay consultas guardadas.</p>';
}
$('#hist-list').addEventListener('click', (e) => {
  const item = e.target.closest('.hist-item'); if (!item) return;
  const h = JSON.parse(localStorage.getItem(HKEY) || '[]')[item.dataset.i];
  $('#chat-empty')?.remove();
  chat.innerHTML = '';
  addBubble('user', esc(h.q));
  addBubble('bot', `<div class="md">${renderMD(h.answer)}</div>`);
  renderSources($('#sources'), h.fuentes);
  location.hash = 'consulta';
});
$('#clear-hist').addEventListener('click', () => {
  if (confirm('¿Borrar todo el historial local?')) { localStorage.removeItem(HKEY); renderHistory(); }
});
