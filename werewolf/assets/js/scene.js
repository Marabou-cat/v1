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
}

/* Colour-code the running event by what it IS, so a death reads differently from a
   phase change without having to parse the sentence. */
function classifyEvent(text) {
    const el = document.getElementById('game-event-log');
    if (!el) return;
    const t = String(text || '').toLowerCase();
    let cls = '';
    if (/died|dead|killed|slain|lynch|execut|driven out|mauled|body of|no longer among/.test(t)) cls = 'ev-death';
    else if (/vote|abstain|ballot|distrust/.test(t)) cls = 'ev-vote';
    else if (/night|moon|dark/.test(t)) cls = 'ev-night';
    else if (/day|sun|dawn|discuss|village|morning/.test(t)) cls = 'ev-day';
    el.classList.remove('ev-death', 'ev-night', 'ev-day', 'ev-vote');
    if (cls) el.classList.add(cls);
}

/* A dead seat wears a broken skull from the downloaded set instead of a generic glyph. */
function seatStatusIconHtml(alive) {
    if (alive) return '<i data-lucide="shield" size="20" style="color:#38bdf8;flex:none"></i>';
    return '<span class="status-dead-ico" title="eliminated" aria-label="eliminated"></span>';
}
