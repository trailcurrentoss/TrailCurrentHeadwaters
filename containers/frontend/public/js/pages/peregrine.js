// Peregrine chat page — talks to the Peregrine NPU LLM through the
// backend proxy at /api/peregrine/chat. The backend holds the TLS
// client role (so a self-signed Peregrine CA only has to be trusted in
// the backend container, not on each phone), forwards the SSE stream
// through, and keeps the request authenticated with our regular session
// token / API key. The Peregrine URL and CA are configured in Settings →
// Peregrine.
//
// Conversation state lives entirely in the browser (localStorage) and
// each request resends the full history.

import { API } from '../api.js';

// Legacy single-history key (pre-conversations panel). Migrated on first
// load if present.
const HISTORY_KEY = 'peregrine-chat-history';
// New multi-conversation storage. Each entry: { id, title, messages, updated_at }.
const CONVERSATIONS_KEY = 'peregrine-conversations';
const ACTIVE_CONV_KEY = 'peregrine-active-conversation';
const CHAT_ENDPOINT = '/api/peregrine/chat';

// Cache of the upstream URL (for display only). Loaded once per page
// init via API.getPeregrineConfig().
let upstreamUrl = '';

let state = null;

function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function loadConversations() {
    // Try new storage first.
    try {
        const raw = localStorage.getItem(CONVERSATIONS_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr;
        }
    } catch (_) {}
    // One-time migration from the legacy single-history key.
    try {
        const legacy = localStorage.getItem(HISTORY_KEY);
        if (legacy) {
            const msgs = JSON.parse(legacy);
            if (Array.isArray(msgs) && msgs.length) {
                const conv = {
                    id: _uuid(),
                    title: deriveTitle(msgs),
                    messages: msgs,
                    updated_at: Date.now(),
                };
                saveConversations([conv]);
                setActiveConversationId(conv.id);
                return [conv];
            }
        }
    } catch (_) {}
    return [];
}

function saveConversations(convs) {
    try { localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(convs)); }
    catch (_) { /* quota */ }
}

function getActiveConversationId() {
    try { return localStorage.getItem(ACTIVE_CONV_KEY) || null; }
    catch (_) { return null; }
}

function setActiveConversationId(id) {
    try {
        if (id) localStorage.setItem(ACTIVE_CONV_KEY, id);
        else localStorage.removeItem(ACTIVE_CONV_KEY);
    } catch (_) {}
}

function deriveTitle(messages) {
    const first = (messages || []).find(m => m.role === 'user');
    if (!first || !first.content) return 'New conversation';
    const t = first.content.trim().replace(/\s+/g, ' ');
    return t.length > 42 ? t.slice(0, 42) + '…' : t;
}

// Legacy-shaped helpers so the rest of the file (send / stream / render)
// keeps working with a single-history array. `activeHistory()` returns the
// current conversation's message array; setting it back happens via
// `commitActiveHistory()`.
let conversations = [];
let activeId = null;

function activeHistory() {
    const c = conversations.find(c => c.id === activeId);
    return c ? c.messages : [];
}

function commitActiveHistory(messages) {
    let conv = conversations.find(c => c.id === activeId);
    if (!conv) {
        conv = { id: _uuid(), title: deriveTitle(messages), messages, updated_at: Date.now() };
        conversations.unshift(conv);
        activeId = conv.id;
        setActiveConversationId(activeId);
    } else {
        conv.messages = messages;
        conv.updated_at = Date.now();
        if (conv.title === 'New conversation' || !conv.title) conv.title = deriveTitle(messages);
    }
    // Keep newest first for the panel.
    conversations.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    saveConversations(conversations);
}

function loadHistory() {
    // Compatibility shim — returns the active conversation's messages.
    if (!conversations.length) {
        conversations = loadConversations();
        activeId = getActiveConversationId();
        // If active id was cleared or points at a deleted conv, drop it.
        if (activeId && !conversations.find(c => c.id === activeId)) activeId = null;
        setActiveConversationId(activeId);
    }
    return activeHistory();
}

function saveHistory(history) {
    // Compatibility shim — commits the active conversation.
    commitActiveHistory(history);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
    catch (e) { /* quota, ignore */ }
}

// ─── Markdown rendering ────────────────────────────────────────────────────
// Mirrors the renderer in TrailCurrentPeregrine/src/web_chat.py so the
// PWA chat renders bold/italic, headings, lists, links, inline code and
// fenced code blocks (with a copy button + optional language label).
// Everything from the model is HTML-escaped before any tag insertion.

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}
function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code class="peregrine-inline-code">${code}</code>`);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
        if (!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return m;
        return '<a href="' + escapeAttr(url) +
               '" target="_blank" rel="noopener noreferrer">' + txt + '</a>';
    });
    return out;
}
function renderTextBlock(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            const lvl = Math.min(h[1].length, 4);
            out.push('<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>');
            i++; continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push('<li>' + renderInline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
                i++;
            }
            out.push('<ul>' + items.join('') + '</ul>');
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                items.push('<li>' + renderInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
                i++;
            }
            out.push('<ol>' + items.join('') + '</ol>');
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim()
               && !/^#{1,6}\s/.test(lines[i])
               && !/^\s*[-*]\s+/.test(lines[i])
               && !/^\s*\d+\.\s+/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        out.push('<p>' + para.map(renderInline).join('<br>') + '</p>');
    }
    return out.join('');
}
function renderMarkdown(src) {
    if (!src) return '';
    const parts = [];
    const fenceRe = /```([a-zA-Z0-9_+\-.]*)\n?([\s\S]*?)(?:```|$)/g;
    let last = 0, m;
    while ((m = fenceRe.exec(src)) !== null) {
        if (m.index > last) parts.push({ t: 'text', v: src.slice(last, m.index) });
        parts.push({ t: 'code', lang: m[1] || '', code: m[2] || '' });
        last = fenceRe.lastIndex;
        if (m[0].length === 0) fenceRe.lastIndex++;
    }
    if (last < src.length) parts.push({ t: 'text', v: src.slice(last) });

    return parts.map(p => {
        if (p.t === 'code') {
            const langLabel = '<span class="lang">' + escapeHtml(p.lang || 'code') + '</span>';
            return '<pre class="peregrine-codeblock"><div class="codehead">' +
                   langLabel +
                   '<button class="copy" type="button" aria-label="Copy code">Copy</button>' +
                   '</div><code data-source="' + escapeAttr(p.code) + '">' +
                   escapeHtml(p.code) + '</code></pre>';
        }
        return renderTextBlock(p.v);
    }).join('');
}

// ─── DOM helpers ───────────────────────────────────────────────────────────

function addBubble(log, role, text) {
    const msg = document.createElement('div');
    msg.className = 'peregrine-msg peregrine-msg-' + role;
    const who = document.createElement('div');
    who.className = 'peregrine-who';
    who.textContent = role === 'user' ? 'You'
                    : role === 'assistant' ? 'Peregrine'
                    : role;
    const bubble = document.createElement('div');
    bubble.className = 'peregrine-bubble';
    if (role === 'assistant') {
        bubble.innerHTML = renderMarkdown(text);
    } else {
        bubble.textContent = text;
    }
    msg.appendChild(who);
    msg.appendChild(bubble);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return bubble;
}

function renderHistory(log, history) {
    log.innerHTML = '';
    for (const m of history) addBubble(log, m.role, m.content);
    log.scrollTop = log.scrollHeight;
}

function copyToClipboard(text, btn) {
    const onDone = () => {
        const original = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('copied');
        }, 1200);
    };
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        try { document.execCommand('copy'); onDone(); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(onDone).catch(fallback);
    } else {
        fallback();
    }
}

// ─── Streaming chat ────────────────────────────────────────────────────────

async function streamChat(history, bubble, abortSignal) {
    // Match the auth headers our regular API.request() uses so the chat
    // endpoint is protected the same way as the rest of /api/*.
    const token  = localStorage.getItem('rv_auth_token');
    const apiKey = (typeof API.getApiKey === 'function') ? API.getApiKey() : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token)  headers['Authorization'] = 'Bearer ' + token;
    if (apiKey) headers['Authorization'] = apiKey;

    const resp = await fetch(CHAT_ENDPOINT, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ messages: history }),
        signal:  abortSignal,
    });
    if (!resp.ok || !resp.body) {
        // Try to surface the JSON error body if the proxy responded with one.
        let detail = '';
        try {
            const j = await resp.clone().json();
            if (j && j.error) detail = ': ' + j.error;
        } catch {}
        throw new Error('HTTP ' + resp.status + detail);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let acc = '';
    let finished = false;
    outer: while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trimStart();
                if (payload === '[DONE]') { finished = true; break outer; }
                try {
                    const evt = JSON.parse(payload);
                    if (evt.done) { finished = true; break outer; }
                    if (evt.delta) {
                        acc += evt.delta;
                        bubble.innerHTML = renderMarkdown(acc);
                        const log = bubble.closest('.peregrine-log');
                        if (log) log.scrollTop = log.scrollHeight;
                    }
                    if (evt.error) {
                        throw new Error(evt.error);
                    }
                } catch (err) {
                    if (err instanceof SyntaxError) continue; // keepalive
                    throw err;
                }
            }
        }
    }
    try { await reader.cancel(); } catch (e) { /* already closed */ }
    return acc;
}

// ─── Page module ───────────────────────────────────────────────────────────

export const peregrinePage = {
    render() {
        return `
            <section class="page-peregrine">
              <aside class="peregrine-conv-panel" id="peregrine-conv-panel" aria-label="Saved conversations">
                <div class="peregrine-conv-header">
                    <span class="peregrine-conv-title">Conversations</span>
                    <button class="peregrine-icon-btn" id="peregrine-new-conv-btn"
                            title="New conversation" aria-label="New conversation">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                </div>
                <div class="peregrine-conv-list" id="peregrine-conv-list"></div>
              </aside>
              <div class="peregrine-chat">
                <header class="peregrine-header">
                    <div class="peregrine-title">
                        <span class="peregrine-dot" aria-hidden="true"></span>
                        <h1>Peregrine</h1>
                    </div>
                    <div class="peregrine-actions">
                        <button class="peregrine-icon-btn" id="peregrine-settings-btn"
                                title="Open Peregrine settings" aria-label="Open Peregrine settings">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                        </button>
                        <button class="peregrine-icon-btn" id="peregrine-clear-btn"
                                title="Clear conversation" aria-label="Clear conversation">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path>
                                <path d="M10 11v6"></path>
                                <path d="M14 11v6"></path>
                                <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </header>

                <div class="peregrine-status-bar" id="peregrine-status-bar"></div>

                <div class="peregrine-log" id="peregrine-log" aria-live="polite"></div>

                <form class="peregrine-form" id="peregrine-form" autocomplete="off">
                    <textarea id="peregrine-input" class="peregrine-input"
                              placeholder="Ask Peregrine anything…"
                              rows="1" aria-label="Message"></textarea>
                    <button type="submit" class="peregrine-send-btn" id="peregrine-send-btn"
                            aria-label="Send">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </form>
              </div>
            </section>
        `;
    },

    _renderConvList() {
        const listEl = document.getElementById('peregrine-conv-list');
        if (!listEl) return;
        if (!conversations.length) {
            listEl.innerHTML = '<p class="peregrine-conv-empty">No saved conversations yet.</p>';
            return;
        }
        listEl.innerHTML = conversations.map(c => `
            <div class="peregrine-conv-item ${c.id === activeId ? 'active' : ''}" data-conv-id="${escapeAttr(c.id)}">
                <button class="peregrine-conv-select" data-action="select" data-conv-id="${escapeAttr(c.id)}"
                        title="${escapeAttr(c.title)}">
                    <span class="peregrine-conv-item-title">${escapeHtml(c.title || 'New conversation')}</span>
                    <span class="peregrine-conv-item-meta">${escapeHtml(new Date(c.updated_at || 0).toLocaleDateString())}</span>
                </button>
                <button class="peregrine-conv-delete" data-action="delete" data-conv-id="${escapeAttr(c.id)}"
                        aria-label="Delete conversation" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path>
                    </svg>
                </button>
            </div>
        `).join('');
    },

    init() {
        const log     = document.getElementById('peregrine-log');
        const form    = document.getElementById('peregrine-form');
        const input   = document.getElementById('peregrine-input');
        const sendBtn = document.getElementById('peregrine-send-btn');
        const clearBtn    = document.getElementById('peregrine-clear-btn');
        const settingsBtn = document.getElementById('peregrine-settings-btn');
        const statusBar   = document.getElementById('peregrine-status-bar');

        let history = loadHistory();
        let inFlight = null;            // AbortController for active request

        state = {
            handlers: [],
            cancel: () => { if (inFlight) inFlight.abort(); },
        };

        renderHistory(log, history);
        this._renderConvList();

        // Conversations panel — click to switch, X to delete, + to new.
        const convPanel = document.getElementById('peregrine-conv-panel');
        const newConvBtn = document.getElementById('peregrine-new-conv-btn');

        const startNewConversation = () => {
            // Only make a fresh one if the current has content.
            if (activeHistory().length === 0) return;
            activeId = null;
            setActiveConversationId(null);
            history = [];
            renderHistory(log, history);
            this._renderConvList();
            input.focus();
        };

        const onConvPanelClick = (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = btn.dataset.convId;
            if (!id) return;
            if (btn.dataset.action === 'select') {
                if (id === activeId) return;
                activeId = id;
                setActiveConversationId(id);
                history = activeHistory();
                renderHistory(log, history);
                this._renderConvList();
                input.focus();
            } else if (btn.dataset.action === 'delete') {
                e.stopPropagation();
                const wasActive = id === activeId;
                conversations = conversations.filter(c => c.id !== id);
                saveConversations(conversations);
                if (wasActive) {
                    activeId = null;
                    setActiveConversationId(null);
                    history = [];
                    renderHistory(log, history);
                }
                this._renderConvList();
            }
        };

        if (convPanel) convPanel.addEventListener('click', onConvPanelClick);
        if (newConvBtn) newConvBtn.addEventListener('click', startNewConversation);

        // Fetch upstream URL + CA status once. We only render the status
        // strip when there's something the user needs to act on (missing
        // CA, config unavailable). A healthy connection stays silent —
        // chat is the primary UI and shouldn't lose vertical space to a
        // permanent banner. `upstreamUrl` is still captured for error
        // messages from the catch branch in the submit handler.
        const renderStatus = (cfg) => {
            if (!statusBar) return;
            if (!cfg) {
                statusBar.textContent = '';
                statusBar.removeAttribute('data-state');
                return;
            }
            const url = cfg.peregrine_url || 'https://peregrine.local';
            upstreamUrl = url;
            const installed = cfg.ca_status && cfg.ca_status.installed;
            const isHttps = /^https:/i.test(url);
            if (isHttps && !installed) {
                statusBar.setAttribute('data-state', 'warn');
                statusBar.innerHTML = `Connected to <code>${escapeHtml(url)}</code> — no CA installed yet. ` +
                    `Upload it in <a href="#settings">Settings → Peregrine</a> if requests fail.`;
            } else {
                // Healthy case — hide the strip to give the chat log
                // the full height. CSS hides `:empty` status bars.
                statusBar.removeAttribute('data-state');
                statusBar.textContent = '';
            }
        };
        API.getPeregrineConfig()
            .then(renderStatus)
            .catch(() => {
                if (statusBar) {
                    statusBar.setAttribute('data-state', 'warn');
                    statusBar.textContent = 'Peregrine configuration unavailable — set it up in Settings.';
                }
            });

        const autoResize = () => {
            input.style.height = 'auto';
            input.style.height = Math.min(200, input.scrollHeight) + 'px';
        };

        const onInput = () => autoResize();
        const onKeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                form.requestSubmit();
            }
        };
        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKeydown);

        // Copy buttons inside assistant bubbles (event delegation so this
        // works for streaming re-renders without re-binding each time).
        const onLogClick = (e) => {
            const btn = e.target.closest('button.copy');
            if (!btn) return;
            const code = btn.closest('pre.peregrine-codeblock').querySelector('code');
            const text = code.dataset.source != null ? code.dataset.source : code.textContent;
            copyToClipboard(text, btn);
        };
        log.addEventListener('click', onLogClick);

        const onClear = () => {
            history = [];
            saveHistory(history);
            renderHistory(log, history);
            this._renderConvList();
            input.focus();
        };
        clearBtn.addEventListener('click', onClear);

        const onOpenSettings = () => {
            // Deep-link to Settings → Peregrine. The router listens for
            // hashchange and navigates there.
            window.location.hash = 'settings';
        };
        settingsBtn.addEventListener('click', onOpenSettings);

        const onSubmit = async (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text || inFlight) return;

            history.push({ role: 'user', content: text });
            saveHistory(history);
            addBubble(log, 'user', text);
            this._renderConvList();
            input.value = '';
            autoResize();
            sendBtn.disabled = true;

            const bubble = addBubble(log, 'assistant', '');
            bubble.parentElement.classList.add('streaming');
            inFlight = new AbortController();
            let acc = '';
            try {
                acc = await streamChat(history, bubble, inFlight.signal);
            } catch (err) {
                if (err.name === 'AbortError') {
                    bubble.parentElement.classList.add('peregrine-msg-error');
                    bubble.textContent = 'Cancelled.';
                } else {
                    bubble.parentElement.classList.add('peregrine-msg-error');
                    const where = upstreamUrl ? ' (upstream: ' + upstreamUrl + ')' : '';
                    bubble.textContent = 'Error: ' + err.message + where
                        + ' — verify the Peregrine URL and CA in Settings → Peregrine.';
                }
            } finally {
                bubble.parentElement.classList.remove('streaming');
                if (acc) {
                    history.push({ role: 'assistant', content: acc });
                    saveHistory(history);
                }
                inFlight = null;
                sendBtn.disabled = false;
                input.focus();
                // Panel: title / order changes after a message.
                this._renderConvList();
            }
        };
        form.addEventListener('submit', onSubmit);

        // Stash handlers so cleanup() can detach them.
        state.handlers.push(
            [input, 'input', onInput],
            [input, 'keydown', onKeydown],
            [log, 'click', onLogClick],
            [clearBtn, 'click', onClear],
            [settingsBtn, 'click', onOpenSettings],
            [form, 'submit', onSubmit],
        );
        if (convPanel) state.handlers.push([convPanel, 'click', onConvPanelClick]);
        if (newConvBtn) state.handlers.push([newConvBtn, 'click', startNewConversation]);

        autoResize();
        // Don't autofocus on mobile (it pops the keyboard immediately).
        if (window.matchMedia('(min-width: 700px)').matches) input.focus();
    },

    cleanup() {
        if (!state) return;
        state.cancel();
        for (const [el, type, fn] of state.handlers) {
            el.removeEventListener(type, fn);
        }
        state = null;
    },
};
