/* werewolf / demo-room.js — the werewolf-demo.html game room, driven by the
   REAL backend poll.  Loaded ONLY by index-demo.html, LAST (after every other
   module), so the function declarations below shadow the live room's own
   presentational renderers.

   It overrides ONLY the presentation layer — roster cards, role card, chat
   bubbles, the action bar, phase subline and the "just acted" pulse.  Every
   piece of gameplay (night actions, voting, HP, voice, overlays, polling) is
   the untouched real thing.  The markup it emits is authored from the
   standalone demo (werewolf-demo.html) and uses .d-* class names, so it never
   depends on index.html's room markup or room.css.  */

/* ================= PLAYER CARD (demo .pcard) ================= */

function dRoleChipClass(role) {
    if (role === 'Werewolf') return 'wolf';
    if (role === 'Seer') return 'seer';
    if (role === 'Doctor' || role === 'Witch' || role === 'Hunter' || role === 'Cupid') return 'seer';
    return 'alive';
}

/* The chip row, on its own, so an optimistic vote can repaint JUST the badges
   without rebuilding (and re-animating) the whole roster. */
function dCardChips(p, data) {
    const isMe = (p.id === data.my_id);
    const alive = !!p.is_alive;
    const chips = [];
    if (isMe) chips.push('<span class="d-chip you">YOU</span>');
    if (!alive) chips.push('<span class="d-chip dead"><i data-lucide="skull" size="11"></i> DEAD</span>');
    // VOTE STATE FIRST: these are the badges that must never be squeezed out.
    if (data.room_status === 'day') {
        if (data.my_vote_id === p.id) chips.push('<span class="d-chip vote"><i data-lucide="vote" size="11"></i> YOUR VOTE</span>');
        if (p.votes > 0) chips.push('<span class="d-chip vote"><i data-lucide="vote" size="11"></i> ' + p.votes + '</span>');
    }
    if (p.is_wolf) chips.push('<span class="d-chip pack">PACK</span>');
    // Roles are public for your own seat and for every DEAD player; living
    // opponents stay 'Hidden' until the final reveal — same rule as the live game.
    const revealed = (p.role && p.role !== 'Hidden' && p.role !== 'unassigned') ? p.role : null;
    if (revealed) chips.push('<span class="d-chip ' + dRoleChipClass(revealed) + '">' + esc(revealed) + '</span>');
    // Chaos Night: distrust is public; HP only ever reaches its own seat.
    if (p.distrust !== null && p.distrust !== undefined) {
        chips.push('<span class="d-chip distrust" title="Public distrust"><i data-lucide="scale" size="11"></i> ' + Math.round(p.distrust) + '%</span>');
    }
    return chips.join('');
}

function dPlayerCard(p, data, extra, index, noAnim) {
    const isMe = (p.id === data.my_id);
    const alive = !!p.is_alive;
    const cls = ['d-pcard'];
    if (isMe) cls.push('me');
    if (!alive) cls.push('dead');
    if (noAnim) cls.push('no-anim');

    const chipsHtml = dCardChips(p, data);
    let hp = '';
    if (data.mode === 'chaos' && data.room_status !== 'ended' && p.hp !== null && p.hp !== undefined) {
        const mx = p.max_hp || 100;
        const pct = Math.max(0, Math.min(100, Math.round(p.hp * 100 / mx)));
        const lvl = pct <= 34 ? ' low' : (pct <= 67 ? ' mid' : '');
        hp = '<span class="d-hp"><span class="d-hp-track"><span class="d-hp-fill' + lvl + '" style="width:' + pct + '%"></span></span><span class="d-hp-num">' + p.hp + '</span></span>';
    }

    // Their latest line floats toward the empty middle as a speech bubble.
    let bubble = '';
    if (data && data.messages && p.nickname) {
        for (let bi = data.messages.length - 1; bi >= 0; bi--) {
            const mm = data.messages[bi];
            if (mm && mm.sender_name === p.nickname) {
                const txt = String(mm.message || '');
                bubble = '<span class="d-pbubble">' + esc(txt.length > 64 ? txt.slice(0, 64) + '…' : txt) + '</span>';
                break;
            }
        }
    }

    const face = alive
        ? avatarHtml(p.avatar, 34)
        : '<span class="avatar" style="width:34px;height:34px"><img src="assets/img/icons/broken-skull.svg" alt=""></span>';

    return '<li class="' + cls.join(' ') + '" data-pid="' + p.id + '" style="animation-delay:' + ((index * 60) % 500) + 'ms">'
        + bubble
        + '<span class="d-pnum">' + p.id + '</span>'
        + '<span class="d-pava">' + face + '</span>'
        + '<span class="d-pbody"><span class="d-pname">' + esc(p.nickname) + '</span></span>'
        + (extra || '')
        + hp
        + (chipsHtml ? '<span class="d-pmeta">' + chipsHtml + '</span>' : '')
        + '</li>';
}

/* Repaint ONLY the badge rows from a (possibly optimistically mutated) payload.
   Used right after a day vote so the tally moves the instant you tap; the next
   poll overwrites it with the server's truth, which is idempotent. */
function dRepaintVoteChips(data) {
    if (!data || !data.players) return;
    const byId = {};
    data.players.forEach(function (p) { byId[p.id] = p; });
    ['game-player-list', 'game-player-list-right'].forEach(function (id) {
        const list = document.getElementById(id);
        if (!list) return;
        Array.prototype.forEach.call(list.querySelectorAll('.d-pcard'), function (card) {
            const p = byId[parseInt(card.dataset.pid, 10)];
            if (!p) return;
            const chips = dCardChips(p, data);
            let meta = card.querySelector('.d-pmeta');
            if (chips) {
                if (!meta) {
                    meta = document.createElement('span');
                    meta.className = 'd-pmeta';
                    card.appendChild(meta);
                }
                meta.innerHTML = chips;
            } else if (meta) {
                meta.remove();
            }
        });
    });
    if (window.lucide) lucide.createIcons();
}

/* The roster renderer.  The game list gets the demo's two rails of cards; the
   lobby roster (and anything else) keeps the live game's own card markup. */
function renderRosterList(listEl, data, buildExtra, mode) {
    state.rosterAvatars = {};
    (data.players || []).forEach(function (p) { if (p.nickname) state.rosterAvatars[p.nickname] = p.avatar; });

    const rosterSig = data.players.map(p => [p.id, p.nickname, p.avatar, p.is_alive, p.role, p.votes, p.hp, p.distrust].join('|')).join('~');
    const fullSig = mode + '|' + rosterSig + '#' + [data.my_role, data.is_alive, data.has_voted, data.my_target_id, data.my_vote_id].join('|');
    if (listEl.dataset.fullSig === fullSig) return;
    const rosterChanged = listEl.dataset.rosterSig !== rosterSig;
    listEl.dataset.fullSig = fullSig;
    listEl.dataset.rosterSig = rosterSig;

    if (listEl.id === 'game-player-list') {
        const players = data.players || [];
        const half = Math.ceil(players.length / 2);
        const rightEl = document.getElementById('game-player-list-right');
        listEl.innerHTML = players.slice(0, half).map((p, i) =>
            dPlayerCard(p, data, buildExtra ? buildExtra(p) : '', i, !rosterChanged)
        ).join('');
        if (rightEl) rightEl.innerHTML = players.slice(half).map((p, i) =>
            dPlayerCard(p, data, buildExtra ? buildExtra(p) : '', i + half, !rosterChanged)
        ).join('');
    } else {
        listEl.innerHTML = (data.players || []).map((p, i) =>
            playerCardHtml(p, data, buildExtra ? buildExtra(p) : '', i, !rosterChanged)
        ).join('');
    }
    if (window.lucide) lucide.createIcons();
}

/* ================= ROLE CARD ================= */
/* The live renderer hunts `document.querySelector('.role-card')`; the demo card
   is `.d-role-card`, so it needs its own. */
function renderRolePanel(role, isWolf) {
    const card = document.getElementById('d-role-card');
    if (!card || !role) return;
    const info = (typeof ROLE_INFO !== 'undefined' && ROLE_INFO[role]) || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.innerText = v; };
    set('rc-goal', info.goal);
    set('rc-ability', info.ability);
    card.classList.toggle('is-wolf', !!isWolf || role === 'Werewolf');
}

/* ================= JUST-ACTED PULSE (demo card class) ================= */
function markCardActed(btn) {
    const card = (btn && btn.closest) ? btn.closest('.d-pcard') : null;
    if (!card) return;
    card.classList.remove('just-acted');
    void card.offsetWidth;
    card.classList.add('just-acted');
}

/* ================= BUG FIX: the choice lock must span BOTH rails =================
   The live lockChoice() only walks the element it is handed, and actions.js hands
   it `#game-player-list` — the LEFT rail. With the roster split across two rails
   the RIGHT rail's Kill/Vote buttons stayed enabled after you had already acted,
   so a player could fire a second action (the server rejects it and the optimistic
   paint rolls back — janky). Lock both rails. */
function lockChoice(scope, chosenBtn, label) {
    const targets = [];
    const add = (el) => { if (el && targets.indexOf(el) < 0) targets.push(el); };
    add(scope);
    add(document.getElementById('game-player-list'));
    add(document.getElementById('game-player-list-right'));
    targets.forEach(function (s) {
        Array.prototype.forEach.call(s.querySelectorAll('.btn-action'), function (b) {
            b.disabled = true;
            b.classList.add('choice-locked');
            if (b === chosenBtn) {
                b.classList.remove('choice-locked');
                b.classList.add('choice-picked');
                b.innerHTML = '<i data-lucide="check" size="16"></i> ' + (label || 'Chosen');
            }
        });
    });
    if (window.lucide) lucide.createIcons();
}

/* ================= BUG FIX: the wolf's bite lands on a demo card =================
   clawSlash() looks for `.player-item` (the live card); demo cards are `.d-pcard`,
   so the slash was silently never drawn. Same effect, correct selector. */
function clawSlash(btn) {
    const card = (btn && btn.closest) ? btn.closest('.d-pcard') : null;
    if (!card) return;
    const s = document.createElement('span');
    s.className = 'claw-slash';
    s.innerHTML = '<b></b><b></b><b></b>';
    card.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 900);
}

/* ================= CHAT BUBBLES (demo .msg) ================= */
function chatBubbleHtml(name, text, mine, system) {
    const cls = 'd-msg' + (system ? ' sys' : '') + (mine ? ' mine' : '');
    const av = system
        ? '<span class="d-mav"><i data-lucide="info" size="18" style="color:#38bdf8"></i></span>'
        : '<span class="d-mav">' + chatAvatarFor(name) + '</span>';
    return '<div class="' + cls + '">'
        + av
        + '<span class="d-mbody"><span class="d-mhead"><b>' + esc(name) + '</b></span>'
        + '<span class="d-mtext">' + text + '</span></span>'
        + '</div>';
}

/* ================= PHASE SUBLINE + ICON =================
   The demo has no event banner, so the live writer (which needs #event-banner)
   no-ops; this keeps the phase icon + subline alive in the demo top bar. */
function updatePhaseBannerText(status, mode, data) {
    if (typeof updatePhaseIcon === 'function') updatePhaseIcon(status, mode);
    const sub = document.getElementById('game-phase-sub');
    if (sub) sub.innerText = (typeof phaseSubline === 'function') ? phaseSubline(status, mode) : '';
}

/* ================= ACTION BAR (demo .action) =================
   Same conditions and the same real buttons as the live skill panel, rendered
   in the demo's single-row action bar. */
function renderSkillPanel(data) {
    const el = document.getElementById('skill-panel');
    if (!el) return;
    const hide = () => { el.style.display = 'none'; el.innerHTML = ''; };
    const show = (inner) => { el.style.display = 'flex'; el.innerHTML = inner; if (window.lucide) lucide.createIcons(); };
    const round = (typeof state !== 'undefined' && state.round) || 1;
    const label = (status) => '<span class="d-alabel">' + status + ' ' + round + '</span>';

    // Day: the vote lives on the cards + the Skip button; the bar just prompts.
    if (data.room_status === 'day') {
        if (!data.is_alive) { hide(); return; }
        const prompt = data.my_vote_skip ? 'You abstained — waiting for the tally…'
            : (data.has_voted ? 'Vote cast. Waiting for the result…'
                              : 'Who should be eliminated? Tap a player — or Skip.');
        show(label('Day') + '<span class="d-aprompt">' + prompt + '</span>');
        return;
    }
    if (data.room_status === 'ended') {
        show('<span class="d-alabel">Finished</span><span class="d-aprompt">The match is over.</span>');
        return;
    }

    const active = (data.room_status === 'night') && !state.inPreNightChat && !!data.is_alive;
    if (!active) { hide(); return; }

    // Doctor — the revive prompt appears only while the night waits on us.
    if (data.my_role === 'Doctor' && data.night_step === 'doctor' && data.doctor_victim_name) {
        show(label('Night')
            + '<span class="d-aprompt">Tonight the pack is about to kill <b>' + esc(data.doctor_victim_name) + '</b>. Use your one revive?</span>'
            + '<button class="btn-action btn-kill" onclick="submitDoctorAction(1, this)"><i data-lucide="heart-pulse" size="16"></i> Revive</button>'
            + '<button class="btn-action" onclick="submitDoctorAction(0, this)"><i data-lucide="x" size="16"></i> Let them die</button>');
        return;
    }

    // Villager / Doctor (classic): tap Sleep — everyone taps, masking who acted.
    if ((data.my_role === 'Villager' || data.my_role === 'Doctor') && data.mode !== 'chaos') {
        if (data.my_asleep) { show(label('Night') + '<span class="d-aprompt"><i data-lucide="moon" size="15"></i> You are asleep. Waiting for the night to pass…</span>'); return; }
        show(label('Night')
            + '<span class="d-aprompt">Bunk down — tap Sleep to get through the night.</span>'
            + '<button class="btn-action" onclick="submitSleep()"><i data-lucide="moon" size="16"></i> Sleep</button>');
        return;
    }

    // Chaos Doctor: a blind heal (Heal buttons live on the cards) or hold medicine.
    if (data.my_role === 'Doctor' && data.mode === 'chaos') {
        const treating = !!data.my_heal_target;
        const held = (Number(data.my_doctor_choice) === 0);
        const prompt = treating ? 'You have chosen who to treat — you will never be told whether it helped.'
            : (held ? 'You are holding your medicine tonight.'
                    : 'Tap a player to treat — or hold your medicine.');
        show(label('Night') + '<span class="d-aprompt">' + prompt + '</span>'
            + ((!treating && !held) ? '<button class="btn-action" onclick="submitNightSkip(this)"><i data-lucide="moon" size="16"></i> Hold medicine</button>' : ''));
        return;
    }

    // Seer — show the most recent divination.
    if (data.my_role === 'Seer' && data.my_seer_result) {
        if (data.mode === 'chaos') {
            const r = String(data.my_seer_result);
            const isWolf = (r === 'Werewolf');
            show(label('Night')
                + '<span class="d-aprompt">You read <b>' + esc(data.my_seer_target_name) + '</b>: '
                + '<b style="color:' + (isWolf ? '#ff4d4d' : '#38bdf8') + '">' + esc(r) + '</b>'
                + ' <span class="d-seer-hp">· ' + data.my_seer_hp + ' HP</span></span>');
            return;
        }
        const isWolf = data.my_seer_result === 'wolf';
        show(label('Night')
            + '<span class="d-aprompt">Your vision of <b>' + esc(data.my_seer_target_name) + '</b>: '
            + '<b style="color:' + (isWolf ? '#ff4d4d' : '#38bdf8') + '">' + (isWolf ? '<i data-lucide="paw-print" size="15"></i> WEREWOLF' : '<i data-lucide="shield-check" size="15"></i> not a werewolf') + '</b></span>');
        return;
    }

    // Werewolf / Seer mid-action: a short status line.
    if (data.my_role === 'Werewolf') {
        show(label('Night') + '<span class="d-aprompt">' + (data.has_voted ? '<i data-lucide="lock" size="15"></i> Target locked in — waiting for the others…' : 'Choose a player to eliminate.') + '</span>');
        return;
    }
    if (data.my_role === 'Seer') {
        show(label('Night') + '<span class="d-aprompt">' + (data.my_check_target ? '<i data-lucide="eye" size="15"></i> Divination complete — waiting for the others…' : 'Choose a player to divine.') + '</span>');
        return;
    }

    // Witch — the one-shot poison, with an explicit pass.
    if (data.my_role === 'Witch') {
        let body;
        if (data.my_poison_used) body = 'Your poison has been spent for this game.';
        else if (data.my_poison_target) body = 'You have marked who to poison tonight.';
        else if (data.my_poison_skip) body = 'You chose not to poison anyone tonight.';
        else body = 'One poison for the whole game — pick a player above, or pass.';
        show(label('Night') + '<span class="d-aprompt">' + body + '</span>'
            + ((!data.my_poison_used && !data.my_poison_target && !data.my_poison_skip)
                ? '<button class="btn-action" onclick="submitNightSkip(this)"><i data-lucide="moon" size="16"></i> Pass tonight</button>' : ''));
        return;
    }

    hide();
}
