/* werewolf / modes — Classic vs Chaos Night
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= GAME MODES =================
   Classic is the original game. Chaos Night replaces the nightly guaranteed kill
   with a HIDDEN HP pool: bites wound, the Doctor heals blind, and only the Seer
   can ever read another player's numbers.

   Nothing in this file ever receives another player's HP — the server only sends
   `my_hp` for your own seat (see lib/actions-play.php). */
const GAME_MODES = {
    classic: {
        id: 'classic',
        label: 'Classic',
        tagline: 'The original',
        blurb: 'One kill every night. The village votes out a suspect each day.',
        icon: 'moon'
    },
    chaos: {
        id: 'chaos',
        label: 'Chaos Night',
        tagline: 'Hidden wounds',
        blurb: 'Everyone hides an HP pool. Wolves wound instead of kill, the Doctor heals blind, and only the Seer can read a body.',
        icon: 'heart-pulse'
    }
};

function isChaos() {
    return state.mode === 'chaos';
}

function modeLabel(m) {
    return (GAME_MODES[m] || GAME_MODES.classic).label;
}

/* Mirrors calculateRoles() in lib/roles.php EXACTLY — keep the two in step, or
   the preview will promise a composition the server does not deal. */
function roleBreakdown(count, mode) {
    let wolves = 1 + Math.floor((count - 4) / 3);
    if (mode === 'chaos' && count >= 5) wolves++;
    const specials = (count === 4) ? 0 : Math.floor((count - 3) / 2);
    return { wolves: wolves, specials: specials, villagers: count - wolves - specials };
}

/* Rewrite the size-picker option labels from the ACTUAL deal for the current
   mode. The markup ships with Classic's numbers baked in, so without this a
   Chaos table would promise "6 Players (1 Werewolf, 1 Special)" and then deal
   two wolves — the count shown at selection MUST match the count dealt. */
function refreshSizeOptions() {
    const mode = state.mode || 'classic';
    ['max-players', 'match-count'].forEach(function (id) {
        const sel = document.getElementById(id);
        if (!sel) return;
        Array.prototype.forEach.call(sel.options, function (o) {
            const n = parseInt(o.value, 10);
            if (!n) return;
            const b = roleBreakdown(n, mode);
            o.textContent = n + ' Players ('
                + b.wolves + (b.wolves === 1 ? ' Werewolf' : ' Werewolves') + ', '
                + b.specials + (b.specials === 1 ? ' Special' : ' Specials') + ')';
        });
    });
}

/* ---- Mode picker (shown for Create Room and Quick Match) ---- */
let modePickerTarget = 'match';

function openModePicker(target) {
    modePickerTarget = target || 'match';
    const el = document.getElementById('mode-modal');
    if (!el) return;
    const cur = state.mode || 'classic';
    el.querySelectorAll('.mode-card').forEach(function (c) {
        c.classList.toggle('on', c.dataset.mode === cur);
    });
    el.classList.add('open');
    if (window.lucide) lucide.createIcons();
}

function closeModePicker() {
    const el = document.getElementById('mode-modal');
    if (el) el.classList.remove('open');
}

function chooseMode(mode) {
    if (!GAME_MODES[mode]) mode = 'classic';
    state.mode = mode;
    closeModePicker();
    playSound('ui_confirm');
    if (modePickerTarget === 'create') showScreen('view-create');
    else showScreen('view-match');
}

/* ---- Your own vitals ----
   ONLY ever called with the local seat's numbers. If my_hp is absent the mode is
   classic (or the player is a spectator) and the pill hides itself. */
function renderVitals(data) {
    const el = document.getElementById('vitals');
    if (!el) return;
    const chaos = !!(data && data.mode === 'chaos');
    const hp = data ? data.my_hp : null;
    if (!chaos || hp === null || hp === undefined) {
        el.style.display = 'none';
        document.body.classList.remove('chaos-mode');
        return;
    }
    document.body.classList.add('chaos-mode');
    const max = data.my_max_hp || 100;
    const pct = Math.max(0, Math.min(100, Math.round(hp * 100 / max)));
    el.style.display = 'block';
    const num = document.getElementById('vitals-num');
    if (num) num.innerText = hp + ' / ' + max;
    const fill = document.getElementById('vitals-fill');
    if (fill) {
        fill.style.width = pct + '%';
        fill.className = 'vitals-fill' + (pct <= 34 ? ' low' : (pct <= 67 ? ' mid' : ''));
    }
    const dl = document.getElementById('vitals-delta');
    if (dl) {
        const d = (data.my_hp_delta === null || data.my_hp_delta === undefined) ? 0 : data.my_hp_delta;
        if (!d) {
            dl.innerText = '';
            dl.className = 'vitals-delta';
        } else {
            dl.innerText = (d > 0) ? ('+' + d + ' restored') : (d + ' damage taken');
            dl.className = 'vitals-delta ' + (d > 0 ? 'up' : 'down');
        }
    }
}

function hideVitals() {
    const el = document.getElementById('vitals');
    if (el) el.style.display = 'none';
    document.body.classList.remove('chaos-mode');
}
