/* werewolf / scene — the day/night world and CLEARER EVENTS.
   ---------------------------------------------------------------------------
   EVERYTHING IN HERE IS CLIENT-SIDE. It makes no requests: the poll already sends
   the room status, the phase anchors and the event text, so classifying an event,
   saying "NIGHT FALLS" in words, or painting a daylight sky costs the server
   nothing and cannot add latency. That was the requirement — richer, not slower. */

/* The roles wear the downloaded artwork (game-icons, CC BY 3.0 — see
   assets/img/icons/CREDITS.md). Unknown roles fall back to the old glyph. */
const ROLE_ICO = {
    Werewolf: 'ico-werewolf',
    Seer: 'ico-seer',
    Doctor: 'ico-doctor',
    Witch: 'ico-witch',
    Hunter: 'ico-hunter',
    Villager: 'ico-villager',
};

function roleIconHtml(role) {
    const cls = ROLE_ICO[role];
    if (cls) return '<span class="role-ico ' + cls + '" aria-hidden="true"></span>';
    return (typeof setRoleIcon === 'function') ? setRoleIcon(role) : '';
}

/* One banner icon that says what time it is at a glance. */
function updatePhaseIcon(status, mode) {
    const el = document.getElementById('phase-ico');
    if (!el) return;
    let cls = 'pb-ico';
    if (status === 'night') cls += (mode === 'chaos') ? ' pb-chaos' : ' pb-night';
    else if (status === 'day') cls += ' pb-day';
    else if (status === 'ended') cls += ' pb-over';
    if (el.className !== cls) el.className = cls;
}

/* Say the phase change in words — the moment that matters most in this game. */
function updatePhaseBannerText(status, mode, data) {
    const el = document.getElementById('event-banner');
    if (!el) return;
    updatePhaseIcon(status, mode);
    el.dataset.phase = status || '';
    const sub = document.getElementById('game-phase-sub');
    if (sub) sub.innerText = phaseSubline(status, mode);
}

/* Colour-code the running event by what it IS, so a death reads differently from a
   phase change without having to parse the sentence. */
function eventClassOf(text) {
    const t = String(text || '').toLowerCase();
    if (/died|dead|killed|slain|lynch|execut|driven out|mauled|body of|no longer among/.test(t)) return 'ev-death';
    if (/vote|abstain|ballot|distrust/.test(t)) return 'ev-vote';
    if (/night|moon|dark/.test(t)) return 'ev-night';
    if (/day|sun|dawn|discuss|village|morning/.test(t)) return 'ev-day';
    return '';
}

function classifyEvent(text) {
    const el = document.getElementById('game-event-log');
    if (!el) return;
    const cls = eventClassOf(text);
    el.classList.remove('ev-death', 'ev-night', 'ev-day', 'ev-vote');
    if (cls) el.classList.add(cls);
}

/* A dead seat wears a broken skull from the downloaded set instead of a generic glyph. */
function seatStatusIconHtml(alive) {
    if (alive) return '<i data-lucide="shield" size="20" style="color:#38bdf8;flex:none"></i>';
    return '<span class="status-dead-ico" title="eliminated" aria-label="eliminated"></span>';
}

/* ================= THE ROOM'S PANELS (top bar / role rail / log) ================= */

const ROLE_INFO = {
    Werewolf: { goal: 'Eliminate the villagers.',       ability: 'Choose one player to kill each night.' },
    Seer:     { goal: 'Find the werewolves.',           ability: 'Inspect one player each night.' },
    Doctor:   { goal: 'Keep the village alive.',        ability: 'Protect one player each night.' },
    Witch:    { goal: 'Tip the balance.',               ability: 'One healing draught, one poison.' },
    Hunter:   { goal: 'Take a wolf down with you.',      ability: 'Shoot one player when you die.' },
    Villager: { goal: 'Survive and expose the threat.',  ability: 'Reason, and vote. That is all you have.' },
};

function renderRolePanel(role, isWolf) {
    const card = document.querySelector('.role-card');
    if (!card || !role) return;
    const info = ROLE_INFO[role] || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.innerText = v; };
    set('rc-goal', info.goal);
    set('rc-ability', info.ability);
    set('my-role-desc', info.goal);
    card.classList.toggle('is-wolf', !!isWolf || role === 'Werewolf');
}

/* Who is on your side. The payload only carries is_wolf for wolves, so for anyone
   else this list is empty and the panel hides — the data never reaches them. */
function renderWolfTeam(data) {
    const box = document.getElementById('wolf-team');
    const list = document.getElementById('wolf-team-list');
    if (!box || !list) return;
    const team = (data.players || []).filter(function (p) { return p.is_wolf && p.id !== data.my_id; });
    if (!team.length) { box.hidden = true; list.innerHTML = ''; list.dataset.sig = ''; return; }
    box.hidden = false;
    const sig = team.map(function (p) { return p.id + (p.is_alive ? 'a' : 'd'); }).join(',');
    if (list.dataset.sig === sig) return;                 // only redraw on real change
    list.dataset.sig = sig;
    list.innerHTML = team.map(function (p) {
        return '<div class="gt-item">' + avatarHtml(p.avatar, 28)
            + '<b>' + esc(p.nickname) + '</b>'
            + (p.is_alive ? '' : '<span class="gt-tag" style="opacity:.55">DEAD</span>')
            + '<span class="gt-tag">WEREWOLF</span></div>';
    }).join('');
}

function renderRoomCounts(data) {
    const ps = data.players || [];
    const alive = ps.filter(function (p) { return p.is_alive; }).length;
    const set = (id, v) => { const el = document.getElementById(id); if (el && el.innerText !== String(v)) el.innerText = String(v); };
    set('gr-count-alive', alive);
    set('gr-count-total', ps.length);
    set('gr-living-count', alive);
}

/* The running log. Client-side narration of what the poll already delivers: no extra
   request, no extra server work. Newest entry sits on top, consistently. */
const GAME_LOG_MAX = 40;
function pushGameLog(text) {
    const ol = document.getElementById('game-log');
    if (!ol) return;
    const t = String(text || '').trim();
    if (!t || ol.dataset.last === t) return;              // the poll repeats events
    ol.dataset.last = t;
    const li = document.createElement('li');
    const cls = (typeof eventClassOf === 'function') ? eventClassOf(t) : '';
    if (cls) li.className = cls;
    const now = new Date();
    const hh = ('0' + now.getHours()).slice(-2), mm = ('0' + now.getMinutes()).slice(-2);
    li.innerHTML = '<span class="gl-time">' + hh + ':' + mm + '</span><span class="gl-msg"></span>';
    li.querySelector('.gl-msg').innerHTML = t;            // server text carries <b> names
    ol.insertBefore(li, ol.firstChild);
    while (ol.children.length > GAME_LOG_MAX) ol.removeChild(ol.lastChild);
}

/* Short, self-dismissing notices. */
function toast(msg, kind) {
    let wrap = document.getElementById('toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = msg;
    wrap.appendChild(el);
    setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { el.remove(); }, 240);
    }, 2200);
}

function phaseSubline(status, mode) {
    if (status === 'night') return (mode === 'chaos') ? 'Distrust is rising...' : 'Werewolves are choosing a target...';
    if (status === 'day')   return 'Players are discussing...';
    if (status === 'ended') return 'The match has ended.';
    return 'Waiting for players...';
}
