const state = {
  token: localStorage.getItem('botOscarAdminToken') || '',
  clients: [],
  campaigns: [],
  runs: [],
  sessions: [],
  paused: [],
  audit: [],
  wa: {
    activeSenderId: null,
    messages: [],
    senders: [],
    sse: null,
  },
  console: {
    entries: [],
    sse: null,
    paused: false,
  },
};

const $ = (selector) => document.querySelector(selector);

const views = {
  dashboard: ['Dashboard', 'Estado en vivo del bot y actividad reciente.'],
  clients: ['Clientes', 'Base operativa, filtros e importación CSV.'],
  campaigns: ['Campañas', 'Preview, cola, estados y control de corridas.'],
  mensajes: ['Mensajes', 'Conversaciones en tiempo real — vista WhatsApp.'],
  sessions: ['Sesiones', 'Conversaciones activas y pausas manuales.'],
  audit: ['Auditoría', 'Trazabilidad reciente de acciones del sistema.'],
  consola: ['Consola', 'Logs en tiempo real del servidor.'],
};

document.addEventListener('DOMContentLoaded', () => {
  $('#token').value = state.token;
  document.querySelectorAll('.nav').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
  $('#saveToken').addEventListener('click', saveToken);
  $('#refresh').addEventListener('click', refreshCurrent);
  document.body.addEventListener('click', handleAction);
  $('#runStatus').addEventListener('change', loadCampaignRuns);
  void loadDashboard();
});

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers['X-Admin-Token'] = state.token;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) throw new Error(await res.text());
  return res.text().then((text) => (text ? JSON.parse(text) : null));
}

function saveToken() {
  state.token = $('#token').value.trim();
  localStorage.setItem('botOscarAdminToken', state.token);
  toast('Token guardado');
}

function switchView(view) {
  document.querySelectorAll('.nav').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === view));
  $('#viewTitle').textContent = views[view][0];
  $('#viewSubtitle').textContent = views[view][1];
  void refreshCurrent();
}

async function refreshCurrent() {
  const active = document.querySelector('.view.active').id;
  if (active === 'dashboard') return loadDashboard();
  if (active === 'clients') return loadClients();
  if (active === 'campaigns') return loadCampaigns();
  if (active === 'mensajes') return loadMensajes();
  if (active === 'sessions') return loadSessions();
  if (active === 'audit') return loadAudit();
  if (active === 'consola') return loadConsola();
}

async function loadDashboard() {
  const [status, runs, audit] = await Promise.all([
    api('/api/status'),
    api('/api/campaign-runs'),
    api('/api/audit?limit=8'),
  ]);
  const activeRuns = runs.filter((run) => ['queued', 'running', 'paused'].includes(run.status));
  $('#metrics').innerHTML = [
    metric('IA', status.aiProvider),
    metric('Sesiones', status.activeSessions),
    metric('Pausados', status.pausedCount),
    metric('Campañas activas', activeRuns.length),
  ].join('');
  $('#activeRuns').innerHTML = renderRunsTable(activeRuns);
  $('#recentAudit').innerHTML = renderAuditTable(audit.events);
}

function metric(label, value) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`;
}

async function loadClients() {
  const params = new URLSearchParams();
  if ($('#clientSearch').value.trim()) params.set('q', $('#clientSearch').value.trim());
  if ($('#clientTag').value.trim()) params.set('tag', $('#clientTag').value.trim());
  state.clients = await api(`/api/clients?${params.toString()}`);
  $('#clientCount').textContent = state.clients.length;
  $('#clientsTable').innerHTML = table(
    ['Nombre', 'Teléfono', 'Empresa', 'Sistemas', 'Tags'],
    state.clients.map((client) => [
      client.name,
      client.phone,
      client.company,
      list(client.systems),
      list(client.tags),
    ]),
  );
}

async function previewImport() {
  const csv = $('#csvInput').value;
  const result = await api('/api/clients/import/preview', {
    method: 'POST',
    body: JSON.stringify({ csv }),
  });
  $('#importPreview').innerHTML = table(
    ['Teléfono', 'Nombre', 'Acción', 'Válido', 'Errores', 'Tags'],
    result.map((item) => [
      item.phone,
      item.name,
      item.action,
      item.valid ? 'sí' : 'no',
      list(item.errors),
      list(item.tags),
    ]),
  );
  $('#importStatus').textContent = `${result.length} filas revisadas`;
}

async function commitImport() {
  const csv = $('#csvInput').value;
  const result = await api('/api/clients/import/commit', {
    method: 'POST',
    body: JSON.stringify({ csv }),
  });
  if (result.invalid?.length) {
    toast(`Hay ${result.invalid.length} filas inválidas`);
    $('#importPreview').innerHTML = table(
      ['Teléfono', 'Nombre', 'Errores'],
      result.invalid.map((item) => [item.phone, item.name, list(item.errors)]),
    );
    return;
  }
  toast(`Clientes importados: ${result.imported}`);
  await loadClients();
}

async function loadCampaigns() {
  const [campaigns] = await Promise.all([api('/api/campaigns'), loadCampaignRuns()]);
  state.campaigns = campaigns;
  $('#campaignList').innerHTML = table(
    ['ID', 'Nombre', 'Modo', 'Estado', 'Acciones'],
    campaigns.map((campaign) => {
      const mode = campaign.messageMode ?? (campaign.template ? 'template' : 'ai');
      const modePill = mode === 'template'
        ? '<span class="pill pill-template">Fijo</span>'
        : '<span class="pill pill-ai">IA</span>';
      const toggleLabel = campaign.enabled ? 'Desactivar' : 'Activar';
      const toggleClass = campaign.enabled ? 'btn-danger' : 'btn-ok';
      return [
        campaign.id,
        campaign.name,
        modePill,
        campaign.enabled ? '<span class="pill">activa</span>' : '<span class="pill danger">inactiva</span>',
        `<div class="row-actions">
          <button data-action="toggle-campaign" data-id="${campaign.id}" data-enabled="${campaign.enabled}" class="${toggleClass}">${toggleLabel}</button>
          <button data-action="preview-campaign" data-id="${campaign.id}">Preview</button>
          <button data-action="run-campaign" data-id="${campaign.id}">Crear corrida</button>
          <button data-action="send-now" data-id="${campaign.id}" class="btn-test" title="Envía ahora ignorando ventana horaria (solo para testing)">⚡ Enviar ahora</button>
        </div>`,
      ];
    }),
  );
}

async function loadCampaignRuns() {
  const status = $('#runStatus')?.value || '';
  state.runs = await api(`/api/campaign-runs${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  $('#campaignRuns').innerHTML = renderRunsTable(state.runs, true);
  return state.runs;
}

function renderRunsTable(runs, actions = false) {
  if (!runs.length) return '<p class="muted">Sin corridas.</p>';
  return table(
    ['ID', 'Campaña', 'Estado', 'Totales', actions ? 'Acciones' : 'Actualizado'],
    runs.map((run) => [
      short(run.id),
      run.campaignId,
      run.status,
      JSON.stringify(run.totals || {}),
      actions
        ? `<div class="row-actions"><button data-action="show-run" data-id="${run.id}">Ver</button><button data-action="pause-run" data-id="${run.id}">Pausar</button><button data-action="resume-run" data-id="${run.id}">Reanudar</button><button data-action="cancel-run" data-id="${run.id}">Cancelar</button></div>`
        : date(run.updatedAt),
    ]),
  );
}

async function showRun(id) {
  const run = await api(`/api/campaign-runs/${id}`);
  $('#runDetail').innerHTML = table(
    ['Teléfono', 'Nombre', 'Estado', 'Intentos', 'Error'],
    run.jobs.map((job) => [job.phone, job.name || '-', job.status, `${job.attempts}/${job.maxAttempts}`, job.error || '-']),
  );
}

async function loadSessions() {
  const [sessions, paused] = await Promise.all([api('/api/sessions'), api('/api/paused')]);
  state.sessions = sessions;
  state.paused = paused.senders || [];
  $('#sessionsTable').innerHTML = table(
    ['Cliente', 'Sender', 'Estado', 'Flujo', 'Actividad'],
    sessions.map((session) => [
      session.clientName,
      session.senderId,
      session.state,
      session.activeConditionalFlowId || session.activeFlowId || '-',
      date(session.lastActivityAt),
    ]),
  );
  $('#pausedList').innerHTML = state.paused.length
    ? table(['Sender', 'Acción'], state.paused.map((sender) => [sender, `<button data-action="resume-one" data-id="${sender}">Reanudar</button>`]))
    : '<p class="muted">No hay pausados.</p>';
}

async function loadAudit() {
  const params = new URLSearchParams({ limit: '100' });
  if ($('#auditEntity').value.trim()) params.set('entityType', $('#auditEntity').value.trim());
  if ($('#auditAction').value.trim()) params.set('action', $('#auditAction').value.trim());
  const response = await api(`/api/audit?${params.toString()}`);
  state.audit = response.events;
  $('#auditTable').innerHTML = renderAuditTable(state.audit);
}

function renderAuditTable(events) {
  if (!events.length) return '<p class="muted">Sin eventos.</p>';
  return table(
    ['Fecha', 'Entidad', 'Acción', 'ID', 'Origen'],
    events.map((event) => [date(event.createdAt), event.entityType, event.action, event.entityId || '-', event.source || event.actor]),
  );
}

async function handleAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'load-clients') await loadClients();
    if (action === 'preview-import') await previewImport();
    if (action === 'commit-import') await commitImport();
    if (action === 'process-worker') {
      const result = await api('/api/campaign-runs/process', { method: 'POST' });
      toast(`${result.processed} jobs procesados`);
      await loadDashboard();
    }
    if (action === 'toggle-campaign') {
      const nowEnabled = button.dataset.enabled === 'true';
      await api(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !nowEnabled }) });
      toast(`Campaña ${!nowEnabled ? 'activada' : 'desactivada'}`);
      await loadCampaigns();
    }
    if (action === 'preview-campaign') {
      const result = await api(`/api/campaigns/${id}/preview`, { method: 'POST', body: JSON.stringify({ limit: 5 }) });
      $('#runDetail').innerHTML = table(['Teléfono', 'Nombre', 'Mensaje'], result.map((item) => [item.phone, item.name || '-', item.message || item.reason || '-']));
    }
    if (action === 'run-campaign') {
      const run = await api(`/api/campaigns/${id}/runs`, { method: 'POST', body: JSON.stringify({}) });
      toast(`Corrida creada ${short(run.id)}`);
      await loadCampaignRuns();
    }
    if (action === 'send-now') {
      const result = await api(`/api/campaigns/${id}/send-now`, { method: 'POST', body: JSON.stringify({}) });
      const jobsSent = result.run?.totals?.sent ?? 0;
      const jobsQueued = result.run?.totals?.queued ?? 0;
      toast(`⚡ Enviado: ${jobsSent} mensajes, en cola: ${jobsQueued}`);
      await loadCampaignRuns();
    }
    if (action === 'show-run') await showRun(id);
    if (['pause-run', 'resume-run', 'cancel-run'].includes(action)) {
      const verb = action.replace('-run', '');
      await api(`/api/campaign-runs/${id}/${verb}`, { method: 'POST' });
      await loadCampaignRuns();
    }
    if (action === 'load-sessions') await loadSessions();
    if (action === 'resume-all') {
      const result = await api('/api/resume/all', { method: 'POST' });
      toast(`Reanudados: ${result.count}`);
      await loadSessions();
    }
    if (action === 'resume-one') {
      await api('/api/resume', { method: 'POST', body: JSON.stringify({ number: id }) });
      await loadSessions();
    }
    if (action === 'load-audit') await loadAudit();
    if (action === 'clear-console') {
      state.console.entries = [];
      renderConsole();
    }
  } catch (error) {
    toast(error.message || 'Error');
  }
}

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">Sin datos.</p>';
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${typeof cell === 'string' && cell.includes('<') ? cell : escapeHtml(String(cell ?? '-'))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function list(values) {
  return Array.isArray(values) && values.length ? values.join(', ') : '-';
}

function short(value) {
  return String(value || '').slice(0, 8);
}

function date(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

// ── WhatsApp message view ────────────────────────────────────

async function loadMensajes() {
  const [messages, senders] = await Promise.all([
    api('/api/messages?limit=200'),
    api('/api/messages/senders'),
  ]);
  state.wa.messages = messages;
  state.wa.senders = senders;
  renderWaSidebar();
  if (state.wa.activeSenderId) {
    renderWaMessages(state.wa.activeSenderId);
  }
  startWaSse();
}

function startWaSse() {
  if (state.wa.sse) return; // already connected
  const url = state.token
    ? `/api/messages/stream?token=${encodeURIComponent(state.token)}`
    : '/api/messages/stream';
  const sse = new EventSource(url);
  state.wa.sse = sse;

  sse.onopen = () => setWaLive(true);
  sse.onerror = () => setWaLive(false);

  sse.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      state.wa.messages.push(msg);

      // update or insert sender
      const existing = state.wa.senders.find((s) => s.senderId === msg.senderId);
      if (existing) {
        existing.lastTs = msg.timestamp;
        if (msg.senderName) existing.senderName = msg.senderName;
      } else {
        state.wa.senders.unshift({ senderId: msg.senderId, senderName: msg.senderName, lastTs: msg.timestamp });
      }
      state.wa.senders.sort((a, b) => b.lastTs - a.lastTs);

      renderWaSidebar();
      if (state.wa.activeSenderId === msg.senderId || state.wa.activeSenderId === null) {
        if (state.wa.activeSenderId === null) waSelectSender(msg.senderId);
        else appendWaBubble(msg);
      }
    } catch {
      // ignore parse errors
    }
  };
}

function stopWaSse() {
  if (state.wa.sse) {
    state.wa.sse.close();
    state.wa.sse = null;
  }
  setWaLive(false);
}

function setWaLive(on) {
  const dot = $('#liveStatus');
  if (!dot) return;
  dot.classList.toggle('connected', on);
  dot.title = on ? 'En vivo' : 'Desconectado';
}

function renderWaSidebar() {
  const el = $('#waContacts');
  if (!el) return;
  if (!state.wa.senders.length) {
    el.innerHTML = '<div class="wa-contact-empty">Sin conversaciones aún</div>';
    return;
  }

  const allMsgs = state.wa.messages;
  el.innerHTML = state.wa.senders.map((s) => {
    const lastMsg = [...allMsgs].reverse().find((m) => m.senderId === s.senderId);
    const preview = lastMsg ? (lastMsg.direction === 'out' ? '🤖 ' : '') + lastMsg.text.slice(0, 40) : '';
    const initial = waInitial(s.senderName || s.senderId);
    const active = state.wa.activeSenderId === s.senderId ? 'active' : '';
    const timeStr = lastMsg ? waTime(lastMsg.timestamp) : '';
    return `<div class="wa-contact ${active}" data-sender="${escapeHtml(s.senderId)}">
      <div class="wa-contact-avatar">${escapeHtml(initial)}</div>
      <div class="wa-contact-info">
        <div class="wa-contact-name">${escapeHtml(waDisplayName(s))}</div>
        <div class="wa-contact-preview">${escapeHtml(preview)}</div>
      </div>
      <div class="wa-contact-time">${escapeHtml(timeStr)}</div>
    </div>`;
  }).join('');

  el.querySelectorAll('.wa-contact[data-sender]').forEach((el) => {
    el.addEventListener('click', () => waSelectSender(el.dataset.sender));
  });
}

function waSelectSender(senderId) {
  state.wa.activeSenderId = senderId;
  renderWaSidebar();
  renderWaMessages(senderId);
}

function renderWaMessages(senderId) {
  const sender = state.wa.senders.find((s) => s.senderId === senderId);
  const msgs = state.wa.messages.filter((m) => m.senderId === senderId);

  // header
  const initial = waInitial(sender ? (sender.senderName || sender.senderId) : senderId);
  const displayName = sender ? waDisplayName(sender) : senderId;
  const phone = senderId.replace('@c.us', '').replace('@lid', '');
  $('#waChatAvatar').textContent = initial;
  $('#waChatName').textContent = displayName;
  $('#waChatSub').textContent = phone;

  const container = $('#waMessages');
  if (!msgs.length) {
    container.innerHTML = '<div class="wa-empty">Sin mensajes aún</div>';
    return;
  }

  container.innerHTML = renderWaBubbles(msgs);
  container.scrollTop = container.scrollHeight;
}

function renderWaBubbles(msgs) {
  let html = '';
  let lastDateLabel = '';

  for (const msg of msgs) {
    const d = new Date(msg.timestamp);
    const dateLabel = d.toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
    if (dateLabel !== lastDateLabel) {
      html += `<div class="wa-date-sep">${escapeHtml(dateLabel)}</div>`;
      lastDateLabel = dateLabel;
    }
    html += waBubbleHtml(msg);
  }
  return html;
}

function waBubbleHtml(msg) {
  const dir = msg.direction === 'out' ? 'out' : 'in';
  const timeStr = new Date(msg.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const tick = msg.direction === 'out' ? '<span class="wa-tick">✓✓</span>' : '';
  const senderLabel = msg.direction === 'in' && msg.senderName
    ? `<div class="wa-sender-label">${escapeHtml(msg.senderName)}</div>` : '';
  const mediaTag = msg.mediaType ? `<em style="font-size:12px;color:#888">[${escapeHtml(msg.mediaType)}]</em> ` : '';
  return `<div class="wa-row ${dir}">
    ${senderLabel}
    <div class="wa-bubble">
      ${mediaTag}${escapeHtml(msg.text)}
      <div class="wa-bubble-meta">
        <span class="wa-bubble-time">${escapeHtml(timeStr)}</span>
        ${tick}
      </div>
    </div>
  </div>`;
}

function appendWaBubble(msg) {
  const container = $('#waMessages');
  if (!container) return;
  const empty = container.querySelector('.wa-empty');
  if (empty) empty.remove();

  // date separator if needed
  const d = new Date(msg.timestamp);
  const dateLabel = d.toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
  const lastSep = container.querySelector('.wa-date-sep:last-of-type');
  if (!lastSep || lastSep.textContent !== dateLabel) {
    container.insertAdjacentHTML('beforeend', `<div class="wa-date-sep">${escapeHtml(dateLabel)}</div>`);
  }

  container.insertAdjacentHTML('beforeend', waBubbleHtml(msg));
  container.scrollTop = container.scrollHeight;
}

function waInitial(name) {
  return String(name || '?').replace('@c.us', '').replace('@lid', '').slice(0, 2).toUpperCase();
}

function waDisplayName(sender) {
  if (sender.senderName) return sender.senderName;
  return sender.senderId.replace('@c.us', '').replace('@lid', '');
}

function waTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7) return d.toLocaleDateString('es-AR', { weekday: 'short' });
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

// ── Consola ──────────────────────────────────────────────────

async function loadConsola() {
  const entries = await api('/api/logs?limit=200');
  state.console.entries = entries;
  renderConsole();
  startConsoleSse();
}

function startConsoleSse() {
  if (state.console.sse) return;
  const url = state.token
    ? `/api/logs/stream?token=${encodeURIComponent(state.token)}`
    : '/api/logs/stream';
  const sse = new EventSource(url);
  state.console.sse = sse;
  sse.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      state.console.entries.push(entry);
      if (state.console.entries.length > 500) state.console.entries.shift();
      if (!state.console.paused) appendConsoleRow(entry);
    } catch { /* ignore */ }
  };
}

function stopConsoleSse() {
  if (state.console.sse) { state.console.sse.close(); state.console.sse = null; }
}

function levelClass(level) {
  if (level === 'ERROR') return 'log-error';
  if (level === 'WARN')  return 'log-warn';
  if (level === 'DEBUG') return 'log-debug';
  return 'log-info';
}

function renderConsole() {
  const output = $('#consoleOutput');
  if (!output) return;
  const filterLevel = $('#consoleLevel')?.value || '';
  const filterText  = ($('#consoleFilter')?.value || '').toLowerCase();
  const filtered = state.console.entries.filter((e) => {
    if (filterLevel && e.level !== filterLevel) return false;
    if (filterText && !e.message.toLowerCase().includes(filterText) && !e.context.toLowerCase().includes(filterText)) return false;
    return true;
  });
  output.innerHTML = filtered.map((e) => consoleRowHtml(e)).join('');
  output.scrollTop = output.scrollHeight;
}

function consoleRowHtml(e) {
  const time = new Date(e.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `<div class="console-row ${levelClass(e.level)}"><span class="console-ts">${escapeHtml(time)}</span><span class="console-level">${escapeHtml(e.level)}</span><span class="console-ctx">${escapeHtml(e.context)}</span><span class="console-msg">${escapeHtml(e.message)}</span></div>`;
}

function appendConsoleRow(entry) {
  const output = $('#consoleOutput');
  if (!output) return;
  const filterLevel = $('#consoleLevel')?.value || '';
  const filterText  = ($('#consoleFilter')?.value || '').toLowerCase();
  if (filterLevel && entry.level !== filterLevel) return;
  if (filterText && !entry.message.toLowerCase().includes(filterText) && !entry.context.toLowerCase().includes(filterText)) return;
  output.insertAdjacentHTML('beforeend', consoleRowHtml(entry));
  output.scrollTop = output.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
  $('#consolePause')?.addEventListener('change', (e) => {
    state.console.paused = e.target.checked;
    if (!state.console.paused) renderConsole();
  });
  $('#consoleLevel')?.addEventListener('change', renderConsole);
  $('#consoleFilter')?.addEventListener('input', renderConsole);
});

// Stop SSE when leaving the mensajes view
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view !== 'mensajes') stopWaSse();
    });
  });

  // Composer send button
  $('#waSend')?.addEventListener('click', async () => {
    const input = $('#waInput');
    const text = input?.value.trim();
    if (!text || !state.wa.activeSenderId) return;
    try {
      await api('/api/test/message', {
        method: 'POST',
        body: JSON.stringify({ senderId: state.wa.activeSenderId, text }),
      });
      input.value = '';
    } catch (err) {
      toast(err.message || 'Error al enviar');
    }
  });

  $('#waInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#waSend')?.click();
    }
  });
});
