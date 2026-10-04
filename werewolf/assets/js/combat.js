/* werewolf / combat — bite feedback, the claw + red smoke, and the event typewriter.
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= EVENT TEXT =================
   The server writes narrative events with **emphasis** markers. Rendering that
   straight into innerHTML did two things wrong: it printed the literal asterisks,
   AND it was an XSS hole (nicknames are user input and were being interpolated
   into HTML). Escape FIRST, then apply emphasis. */
function eventHtml(text) {
    return esc(String(text == null ? '' : text)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

/* Typewriter: reveal an event one character at a time, quickly. Re-typing the same
   string on every poll would be maddening, so it only runs when the text changes. */
function typewriteEvent(text) {
    const el = document.getElementById('game-event-log');
    if (!el) return;
    const t = String(text == null ? '' : text);
    if (el.dataset.twKey === t) return;
    el.dataset.twKey = t;

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    clearTimeout(typewriteEvent._t);
    if (reduce || !t) { el.innerHTML = eventHtml(t); return; }

    const chars = Array.from(t);
    // Fast: ~26ms for a short line, tightening as the line grows so a long
    // sentence never drags.
    const step = Math.max(9, Math.min(26, Math.round(1100 / Math.max(chars.length, 1))));
    let i = 0;
    el.innerText = '';
    const tick = function () {
        i++;
        el.innerText = chars.slice(0, i).join('');
        if (i < chars.length) {
            typewriteEvent._t = setTimeout(tick, step);
        } else {
            el.innerHTML = eventHtml(t);   // land the finished, formatted line
        }
    };
    typewriteEvent._t = setTimeout(tick, step);
}

/* ================= CLAW + RED SMOKE =================
   A bitten player FEELS it during the night, before dawn names the body. The
   server sums every wolf currently pointed at this seat (incoming_damage), so the
   tell scales with how badly the pack is mauling them. */
const CLAW_LEVELS = [
    { max: 0, lvl: 0 },        // untouched
    { max: 33, lvl: 1 },       // one bite, barely
    { max: 67, lvl: 2 },       // two bites
    { max: 101, lvl: 3 },      // three bites — critical
    { max: Infinity, lvl: 4 }  // lethal
];

function clawLevel(dmg) {
    const d = Number(dmg) || 0;
    for (let i = 0; i < CLAW_LEVELS.length; i++) {
        if (d <= CLAW_LEVELS[i].max) return CLAW_LEVELS[i].lvl;
    }
    return 0;
}

function renderClaw(data) {
    let el = document.getElementById('claw-overlay');
    if (!el) return;

    // Only while the night is actually running and this seat is being bitten.
    const night = !!(data && data.room_status === 'night');
    const dmg = (data && night && data.is_alive) ? (Number(data.incoming_damage) || 0) : 0;
    const lvl = clawLevel(dmg);
    const hide = document.getElementById('claw-dmg');

    if (!lvl) {
        if (el.classList.contains('show')) {
            el.classList.remove('show', 'hit');
            el.dataset.lvl = '0';
        }
        return;
    }

    // A fresh bite (level went UP) gets the impact: the marks strike + a shake.
    const prev = Number(el.dataset.lvl || 0);
    const fresh = (lvl > prev);
    el.dataset.lvl = String(lvl);
    el.classList.add('show');
    if (hide) hide.innerText = '-' + dmg;

    // Restart the strike animation on every new bite.
    const marks = el.querySelector('.claw-mark');
    if (marks && fresh) {
        marks.classList.remove('strike');
        void marks.offsetWidth;
        marks.classList.add('strike');
        el.classList.remove('hit');
        void el.offsetWidth;
        el.classList.add('hit');
        if (typeof playSound === 'function') playSound('wolf_kill');
        document.body.classList.remove('bite-shake');
        void document.body.offsetWidth;
        document.body.classList.add('bite-shake');
        setTimeout(function () { document.body.classList.remove('bite-shake'); }, 520);
    } else if (marks) {
        marks.classList.add('strike');
    }
}

function clearClaw() {
    const el = document.getElementById('claw-overlay');
    if (el) { el.classList.remove('show', 'hit'); el.dataset.lvl = '0'; }
    document.body.classList.remove('bite-shake');
}

/* ================= WOLF ATTACK FEEDBACK =================
   The pack's own bite: a slash across the card they just sank their teeth into. */
function clawSlash(btn) {
    const card = btn && btn.closest ? btn.closest('.player-item') : null;
    if (!card) return;
    const s = document.createElement('span');
    s.className = 'claw-slash';
    s.innerHTML = '<b></b><b></b><b></b>';
    card.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 900);
}
