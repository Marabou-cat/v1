/* werewolf / hall — the home screen is a HALL.
   Before anyone joins a room they stand here, so the front page is a place with
   people in it rather than an empty form. Everyone wears a character portrait, and
   the character you wear here is the one that sits down at the table (the join
   calls forward `avatar`, and the server honours it for guests — see seatAvatar()).

   Presence is a lightweight heartbeat: a nickname, an avatar id, a timestamp.
   Nothing about rooms in progress, and the server sweeps stale rows by itself. */

const HALL_KEY_TOKEN = 'werewolf_hall_token';
const HALL_KEY_AV = 'werewolf_hall_avatar';
const HALL_BEAT_MS = 7000;

function hallStore(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
function hallLoad(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

/* A stable per-browser id, so the hall can tell me apart from the others. */
function hallToken() {
    let t = state.hallToken || hallLoad(HALL_KEY_TOKEN);
    if (!t || t.length < 8) {
        t = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        hallStore(HALL_KEY_TOKEN, t);
    }
    state.hallToken = t;
    return t;
}

/* The character I am wearing. Account pick > the one I chose here > a fresh
   random one, persisted so it does not reshuffle on every refresh. */
function myCharacter() {
    const acct = state.authUser && state.authUser.avatar;
    if (isCharacterAvatar(acct)) return acct;
    let a = state.hallChar || hallLoad(HALL_KEY_AV);
    if (!isCharacterAvatar(a)) {
        const all = Object.keys(AVATAR_CHARS);
        a = all[Math.floor(Math.random() * all.length)];
        hallStore(HALL_KEY_AV, a);
    }
    state.hallChar = a;
    return a;
}

function hallNickname() {
    const inp = document.getElementById('nickname');
    const typed = inp && inp.value ? inp.value.trim().slice(0, 24) : '';
    if (typed) return typed;
    if (state.authUser && state.authUser.nickname) return state.authUser.nickname;
    return 'Wanderer';
}

/* Draw the hall. A FIXED number of seats keeps the room the same shape whether it
   is full or empty — an empty hall should look like an empty hall, not a bug. */
const HALL_SEATS = 6;

function renderHall(data) {
    const hero = document.getElementById('hall-hero');
    const stage = document.getElementById('hall-stage');
    if (!hero || !stage) return;

    const mine = myCharacter();
    hero.innerHTML = '<span class="hall-you">' + avatarHtml(mine, 104) + '</span>'
        + '<span class="hall-you-info"><b>' + esc(hallNickname()) + '</b>'
        + '<span class="hall-you-tag" title="Change this in Settings">your character</span></span>';

    const list = (data && data.hall) ? data.hall : [];
    let html = '';
    for (let i = 0; i < HALL_SEATS; i++) {
        const p = list[i];
        if (p) {
            html += '<span class="hall-seat">'
                + '<span class="hall-seat-av">' + avatarHtml(p.avatar, 46) + '</span>'
                + '<b>' + esc(p.nickname) + '</b></span>';
        } else {
            html += '<span class="hall-seat empty">'
                + '<span class="hall-seat-av"><i data-lucide="user" size="18"></i></span>'
                + '<b>empty</b></span>';
        }
    }
    stage.innerHTML = html;

    const count = document.getElementById('hall-count');
    if (count) {
        const n = (data && typeof data.count === 'number') ? data.count : 1;
        count.innerText = n + (n === 1 ? ' soul' : ' souls');
    }
    if (window.lucide) lucide.createIcons();
}

async function hallBeat() {
    const body = new URLSearchParams({
        action: 'hall_beat',
        token: hallToken(),
        nickname: hallNickname(),
        avatar: myCharacter()
    });
    try {
        const res = await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const data = await res.json();
        if (!state.hallOn) return;                 // left the menu while in flight
        if (data && data.status === 'success') {
            state.lastHall = data;
            if (data.avatar && isCharacterAvatar(data.avatar) && data.token === hallToken()) {
                // The server may have re-dealt us an avatar (only if ours was unknown).
                if (!hallLoad(HALL_KEY_AV)) { hallStore(HALL_KEY_AV, data.avatar); state.hallChar = data.avatar; }
            }
            renderHall(data);
        }
    } catch (e) { /* the hall is decoration: never break the menu over it */ }
}

function startHall() {
    state.hallOn = true;
    renderHall(null);                              // paint instantly, then fill in
    hallBeat();
    if (state.hallTimer) clearInterval(state.hallTimer);
    state.hallTimer = setInterval(hallBeat, HALL_BEAT_MS);
}

function stopHall() {
    state.hallOn = false;
    if (state.hallTimer) { clearInterval(state.hallTimer); state.hallTimer = null; }
}

/* Repaint when the character or the name changes (settings panel / avatar picker). */
function refreshHallSeat() {
    if (state.hallOn) { renderHall(state.lastHall || null); hallBeat(); }
}
