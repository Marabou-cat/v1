/* werewolf / victory — the end-of-match settlement.
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= VICTORY SETTLEMENT =================
   Shown once, when the room flips to 'ended': who won, everyone's real role,
   and two callouts —
     * Sharpest Villager: the villager whose DAY votes landed on werewolves most
     * Deadliest Wolf:     the wolf whose kills took the most power roles
   Both are accumulated server-side at resolution time (players.wolf_votes /
   players.special_kills), so the client just renders what the poll hands it. */

function victoryWinnerLabel(w) {
    return (w === 'werewolves') ? 'WEREWOLVES WIN' : 'VILLAGE WINS';
}

function showVictoryOverlay(data) {
    const w = data.winner || '';
    if (!w) return;                      // abandoned lobby: nothing to celebrate

    const mv = data.mvp_villager, mw = data.mvp_wolf;
    const sig = [w, mv ? mv.name + mv.count : '', mw ? mw.name + mw.count : ''].join('|');
    let el = document.getElementById('victory-overlay');
    if (el && el.dataset.sig === sig) return;     // never replay the same result
    if (!el) {
        el = document.createElement('div');
        el.id = 'victory-overlay';
        document.body.appendChild(el);
    }
    el.dataset.sig = sig;
    el.className = 'victory-overlay ' + (w === 'werewolves' ? 'vc-wolf-side' : 'vc-villager-side');

    const chaos = (data.mode === 'chaos');

    const roster = (data.players || []).map(function (p) {
        const role = (p.role && p.role !== 'Hidden' && p.role !== 'unassigned') ? p.role : 'Unknown';
        const wolf = (role === 'Werewolf');
        // HP is revealed to everyone only now that the match is over.
        const hpCell = (chaos && p.hp !== null && p.hp !== undefined)
            ? '<span class="vc-hp">' + p.hp + '</span>' : '';
        return '<li class="vc-row' + (p.is_alive ? '' : ' vc-dead') + (wolf ? ' vc-is-wolf' : '') + '">'
            + avatarHtml(p.avatar, 26)
            + '<span class="vc-name">' + esc(p.nickname) + '</span>'
            + hpCell
            + '<span class="vc-role">' + esc(role) + '</span>'
            + (p.is_alive ? '' : '<span class="vc-x">✝</span>')
            + '</li>';
    }).join('');

    let mine = '';
    if (data.my_user_id && data.my_rating_delta !== null && data.my_rating_delta !== undefined) {
        const d = data.my_rating_delta;
        mine = '<div class="vc-mine">' + (data.my_user_won ? 'Victory' : 'Defeat')
            + ' · Rank ' + (d >= 0 ? '+' : '') + d
            + (data.my_xp_delta ? ' · +' + data.my_xp_delta + ' XP' : '') + '</div>';
    } else if (!data.my_user_id) {
        mine = '<div class="vc-mine vc-mine-guest">Guest match — sign in to earn rank &amp; XP</div>';
    }

    function award(m, cls, title, sub) {
        if (!m) return '';
        return '<div class="vc-award ' + cls + '">'
            + '<div class="vc-award-h">' + title + '</div>'
            + '<div class="vc-award-b">' + avatarHtml(m.avatar, 38)
            + '<span class="vc-award-n">' + esc(m.name) + '</span>'
            + '<span class="vc-award-c">' + m.count + (m.unit ? ' ' + esc(m.unit) : '') + '</span></div>'
            + '<div class="vc-award-s">' + sub + '</div>'
            + '</div>';
    }

    el.innerHTML =
        '<div class="vc-card">'
        + '<div class="vc-glow"></div>'
        + '<div class="vc-banner">' + victoryWinnerLabel(w) + '</div>'
        + '<div class="vc-sub">' + esc(data.last_event || '') + '</div>'
        + mine
        + '<div class="vc-awards">'
        + award(mv, 'vc-a1', 'Sharpest Villager', 'day votes that landed on a werewolf')
        + award(mw, 'vc-a2', 'Deadliest Wolf', chaos ? 'total damage dealt' : 'power roles taken at night')
        + '</div>'
        + '<div class="vc-head">Final Roster</div>'
        + '<ul class="vc-roster">' + roster + '</ul>'
        + '<div class="vc-actions"><button class="btn-primary" onclick="closeVictory()">Back to Menu</button></div>'
        + '</div>';

    if (window.lucide) lucide.createIcons();

    // Sting: an ominous toll for the wolves, a bright chime for the village.
    playSound(w === 'werewolves' ? 'lynch' : 'day_break');

    // Restart the entrance animation even if the overlay already existed.
    el.classList.remove('vc-in');
    void el.offsetWidth;
    el.classList.add('vc-in');
}

function closeVictory() {
    const el = document.getElementById('victory-overlay');
    if (el) el.remove();
    if (typeof leaveToMenu === 'function') leaveToMenu();
}
