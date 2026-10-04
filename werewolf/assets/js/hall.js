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

/* The character I am wearing: a BUILT one (code), an account pick, the one I chose
   here, or a fresh random cast member — persisted so it never reshuffles. */
function myCharacter() {
    const custom = (typeof isCustomAvatar === 'function') ? isCustomAvatar : function () { return false; };
    const acct = state.authUser && state.authUser.avatar;
    if (acct && (custom(acct) || isCharacterAvatar(acct))) return acct;
    let a = state.hallChar || hallLoad(HALL_KEY_AV);
    if (a && (custom(a) || isCharacterAvatar(a))) { state.hallChar = a; return a; }
    const all = Object.keys(AVATAR_CHARS);
    a = all[Math.floor(Math.random() * all.length)];
    hallStore(HALL_KEY_AV, a);
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
    hero.innerHTML = '<button class="hall-you-btn" onclick="openAvatarBuilder()" title="Build your character">'
        + '<span class="hall-you">' + avatarHtml(mine, 104) + '</span>'
        + '<span class="hall-you-info"><b>' + esc(hallNickname()) + '</b>'
        + '<span class="hall-you-tag">your character &middot; tap to build</span></span>'
        + '</button>';

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

/* ================= CHOOSING YOUR CHARACTER =================
   A GUEST has no account to hang an avatar on, so the hall is where they pick one
   — tap your own portrait. Signed-in players who pick here also save it to the
   account (pickAvatar), so the choice follows them to every device. */
function openCharacterPicker() {
    let m = document.getElementById('char-picker');
    if (!m) {
        m = document.createElement('div');
        m.id = 'char-picker';
        m.className = 'char-picker';
        document.body.appendChild(m);
    }
    const cur = myCharacter();
    m.innerHTML = '<div class="cp-card">'
        + '<div class="cp-head"><h3>Choose your character</h3>'
        + '<span class="cp-sub">This is the face you wear in the hall and at the table.</span></div>'
        + '<div class="cp-grid">'
        + avatarAllIds().map(function (k) {
            const d = avatarDef(k);
            const on = (k === cur) ? ' on' : '';
            return '<button class="cp-item' + on + '" onclick="chooseCharacter(\'' + k + '\')" title="' + esc(d.label) + '">'
                + avatarHtml(k, 52) + '<b>' + esc(d.label) + '</b></button>';
        }).join('')
        + '</div>'
        + '<button class="cp-close" onclick="closeCharacterPicker()">Done</button>'
        + '</div>';
    m.classList.add('show');
    if (window.lucide) lucide.createIcons();
}

function chooseCharacter(id) {
    if (!isCharacterAvatar(id) && !AVATARS[id]) return;
    state.hallChar = id;
    hallStore(HALL_KEY_AV, id);
    if (typeof playSound === 'function') playSound('ui_click');
    // Signed in: persist to the account too so every device agrees.
    if (state.authUser && typeof pickAvatar === 'function') pickAvatar(id);
    renderHall(state.lastHall || null);
    openCharacterPicker();                  // repaint the grid with the new tick
    if (state.hallOn) hallBeat();            // show the new face to the hall at once
}

function closeCharacterPicker() {
    const m = document.getElementById('char-picker');
    if (m) m.classList.remove('show');
}

/* Tap anywhere outside the card, or Esc, to dismiss. */
document.addEventListener('click', function (e) {
    const m = document.getElementById('char-picker');
    if (!m || !m.classList.contains('show')) return;
    if (e.target === m) closeCharacterPicker();
});
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeCharacterPicker();
});
