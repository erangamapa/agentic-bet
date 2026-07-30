/**
 * Web client.
 *
 * Deliberately thin: it renders chat, and it renders state the server owns.
 * There is no stake validation, no confirmation logic and no notion of what
 * makes a bet "placed" here — the Confirm button posts to the same service the
 * Telegram /confirm command calls, and bet status is displayed straight from
 * `txStatus`. Duplicating any of that in the client is exactly the drift the
 * architecture is meant to prevent.
 */

const $ = (id) => document.getElementById(id);
const messages = $('messages');
const sessionId = `sess_web_${Math.random().toString(36).slice(2, 10)}`;

const userId = () => $('user-id').value.trim() || 'usr_demo';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-user-id': userId(),
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && body.error) throw new Error(body.error.message ?? 'Request failed');
  return body;
}

// --- chat -------------------------------------------------------------------

function addMessage(role, html, traceUrl) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = html;
  if (traceUrl) {
    const link = document.createElement('a');
    link.className = 'trace-link';
    link.href = traceUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'view trace →';
    bubble.appendChild(link);
  }
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  return wrap;
}

/** Minimal markdown: paragraphs, bold, inline code, bullet lists. */
function renderMarkdown(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

function inline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  $('send').disabled = true;
  addMessage('user', renderMarkdown(text));

  const thinking = addMessage('assistant', '<p>thinking…</p>');
  thinking.classList.add('thinking');

  try {
    const result = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, sessionId }),
    });
    thinking.remove();
    addMessage('assistant', renderMarkdown(result.reply), result.traceUrl);
  } catch (err) {
    thinking.remove();
    addMessage('assistant', `<p class="muted">Error: ${err.message}</p>`);
  } finally {
    $('send').disabled = false;
    input.focus();
    refreshAll();
  }
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('input').value = chip.dataset.prompt;
    $('input').focus();
  });
});

// --- bet builder ------------------------------------------------------------
// A non-chat way in. It posts to /api/suggestions, which calls the same
// privileged quote service the agent's quote_bet tool calls — so limits and the
// confirmation flow are identical whether the user clicks or types.

let marketCache = [];

async function loadMarkets() {
  try {
    const { markets } = await api('/api/markets');
    marketCache = markets.filter((m) => m.status === 'open');
    const select = $('b-market');
    select.innerHTML = marketCache
      .map((m) => `<option value="${m.id}">${m.homeTeam} v ${m.awayTeam}</option>`)
      .join('');
    renderSelections();
  } catch {
    /* markets panel is optional; chat still works */
  }
}

function renderSelections() {
  const market = marketCache.find((m) => m.id === $('b-market').value);
  $('b-selection').innerHTML = (market?.selections ?? [])
    .map((s) => `<option value="${s.id}">${s.label} — ${s.odds}</option>`)
    .join('');
}

$('b-market').addEventListener('change', renderSelections);

$('builder').addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('builder-msg');
  msg.textContent = '';
  try {
    const quote = await api('/api/suggestions', {
      method: 'POST',
      body: JSON.stringify({
        marketId: $('b-market').value,
        selectionId: $('b-selection').value,
        stake: Number($('b-stake').value),
      }),
    });
    msg.textContent = `Quoted ${quote.stake} @ ${quote.odds} — code ${quote.confirmCode}`;
    refreshSlip();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// --- bet slip ---------------------------------------------------------------

async function refreshSlip() {
  const slip = $('slip');
  try {
    const { suggestions } = await api('/api/suggestions');
    if (!suggestions.length) {
      slip.innerHTML = '<p class="empty">Nothing awaiting confirmation.</p>';
      return;
    }
    slip.innerHTML = '';
    for (const s of suggestions) {
      const item = document.createElement('div');
      item.className = 'slip-item';
      const confirmed = s.status === 'confirmed';
      item.innerHTML = `
        <div class="slip-head">
          <span>${s.selectionId} · ${s.marketId.replace('mkt_', '')}</span>
          <span class="code">${s.confirmCode}</span>
        </div>
        <p class="slip-meta">${s.stake} @ ${s.odds} → returns ${s.potentialReturn}<br>${s.rationale}</p>
        <div class="slip-actions">
          <button class="primary" data-act="${confirmed ? 'place' : 'confirm'}" data-id="${s.id}">
            ${confirmed ? 'Place bet' : 'Confirm'}
          </button>
          <button data-act="dismiss" data-id="${s.id}">Dismiss</button>
        </div>`;
      slip.appendChild(item);
    }
  } catch (err) {
    slip.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

$('slip').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const { act, id } = button.dataset;
  button.disabled = true;

  try {
    if (act === 'confirm') {
      await api(`/api/suggestions/${id}/confirm`, { method: 'POST' });
      addMessage('assistant', '<p>Confirmed. Press <strong>Place bet</strong> or tell me to place it.</p>');
    } else if (act === 'place') {
      const outcome = await api(`/api/suggestions/${id}/place`, { method: 'POST' });
      // Wording is driven strictly by the server's status — the client never
      // decides that a bet counts as placed.
      if (outcome.status === 'confirmed') {
        addMessage(
          'assistant',
          `<p><strong>Bet placed.</strong> ${outcome.stake} @ ${outcome.odds}, returns ${outcome.potentialReturn}.</p><p class="muted">tx <code>${outcome.txHash}</code></p>`,
        );
      } else if (outcome.status === 'pending') {
        addMessage(
          'assistant',
          `<p><strong>Still confirming.</strong> The transaction was broadcast but has not confirmed yet, so this is not a placed bet.</p><p class="muted">execution <code>${outcome.executionId}</code></p>`,
        );
      } else {
        addMessage(
          'assistant',
          `<p><strong>Not placed.</strong> ${outcome.failureReason ?? 'The execution failed.'}</p>`,
        );
      }
    } else if (act === 'dismiss') {
      await api(`/api/suggestions/${id}/dismiss`, { method: 'POST' });
    }
  } catch (err) {
    addMessage('assistant', `<p class="muted">${err.message}</p>`);
  } finally {
    refreshAll();
  }
});

$('refresh-slip').addEventListener('click', refreshSlip);

// --- bets -------------------------------------------------------------------

async function refreshBets() {
  const el = $('bets');
  try {
    const { bets } = await api('/api/bets');
    if (!bets.length) {
      el.innerHTML = '<p class="empty">No bets yet.</p>';
      return;
    }
    el.innerHTML = bets
      .map(
        (b) => `
        <div class="bet-row">
          <span>${b.selectionId} · ${b.stake} @ ${b.odds}</span>
          <span class="status ${b.txStatus}">${b.txStatus}</span>
        </div>`,
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

// --- audit ------------------------------------------------------------------

async function refreshAudit() {
  const el = $('audit');
  try {
    const { events } = await api('/api/audit?limit=40');
    if (!events.length) {
      el.innerHTML = '<p class="empty">No activity yet.</p>';
      return;
    }
    el.innerHTML = events
      .map((e) => {
        const time = new Date(e.createdAt).toLocaleTimeString();
        const role = e.agentRole ? `<span class="role">${e.agentRole}</span>` : '';
        const extra = e.detail?.tool ? ` ${e.detail.tool}` : '';
        return `<div class="audit-row"><span class="kind">${e.kind}${extra}</span>${role}<span>${time}</span></div>`;
      })
      .join('');
  } catch (err) {
    el.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

$('refresh-audit').addEventListener('click', refreshAudit);

// --- token usage ------------------------------------------------------------

async function refreshUsage() {
  const el = $('usage');
  try {
    const usage = await api('/api/usage');
    if (!usage.byRole.length) {
      el.innerHTML = '<p class="empty">No LLM calls yet.</p>';
      return;
    }
    el.innerHTML = usage.byRole
      .map(
        (r) => `
        <div class="usage-row">
          <span>${r.agentRole}</span>
          <span>${r.totalTokens.toLocaleString()} tok · ${r.calls} calls</span>
        </div>
        <div class="bar" style="width:${Math.max(4, r.shareOfTotal * 100)}%"></div>`,
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

// --- boot -------------------------------------------------------------------

async function refreshAll() {
  await Promise.all([refreshSlip(), refreshBets(), refreshAudit(), refreshUsage()]);
}

async function loadHealth() {
  try {
    const health = await fetch('/health').then((r) => r.json());
    $('mode-badge').textContent = `${health.executionMode} · ${health.store}`;
  } catch {
    $('mode-badge').textContent = 'offline';
  }
}

$('user-id').addEventListener('change', refreshAll);

loadHealth();
loadMarkets();
refreshAll();
setInterval(refreshAll, 15000);
