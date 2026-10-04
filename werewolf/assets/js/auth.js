/* werewolf / auth — optional passwordless accounts.

   There is no password form anywhere: you type an email, we mail a 6-digit code,
   you type the code. Register and sign-in are the same flow (the first verified
   code creates the account). Guests are first-class — none of this is needed to
   play, it only unlocks the win rate and rank. */

let authMode = 'login';        // only changes the dialog copy
let authStep = 'email';        // 'email' -> 'code'
let authResendInterval = null;

function authEl(id) { return document.getElementById(id); }

function authTierClass(tier) {
    return 'tier-' + String(tier || 'Bronze').toLowerCase();
}

// Repaint the top-right bar for a signed-in user, or back to the guest buttons.
function applyAuthUser(u) {
    const guest = authEl('auth-guest');
    const user  = authEl('auth-user');
    if (!guest || !user) return;
    state.authUser = (u && u.name) ? u : null;

    // The poll calls this every tick; only touch the DOM when it really changed.
    const sig = state.authUser
        ? [u.name, u.tier, u.rating, u.games, u.wins].join('|')
        : '';
    if (sig === state.authSig) return;
    state.authSig = sig;

    if (state.authUser) {
        guest.style.display = 'none';
        user.style.display = 'flex';
        // Rank emblem instead of text; the tier name rides the tooltip.
        const tier = authEl('auth-tier');
        tier.innerHTML = rankIconSvg(u.tier);
        tier.title = u.tier;
        authEl('auth-name').innerText = u.name;
        authEl('auth-stats').innerText = u.games > 0
            ? `${u.rating} · ${u.wins}W-${u.losses}L · ${u.win_rate}%`
            : 'no ranked games yet';
    } else {
        guest.style.display = 'flex';
        user.style.display = 'none';
    }
    if (window.lucide) lucide.createIcons();
    if (typeof renderSettingsAccount === 'function') renderSettingsAccount();
}

async function refreshAuth() {
    try {
        const res = await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'me' })
        });
        const data = await res.json();
        if (data.status === 'success') applyAuthUser(data.user);
    } catch (e) { /* offline / first paint — stay a guest */ }
}

/* ---------------- the dialog ---------------- */

function stopResendTimer() {
    if (authResendInterval) { clearInterval(authResendInterval); authResendInterval = null; }
    const b = authEl('auth-resend');
    if (b) { b.disabled = false; b.innerText = 'Resend'; }
}

function startResendTimer(seconds) {
    if (authResendInterval) { clearInterval(authResendInterval); authResendInterval = null; }
    const btn = authEl('auth-resend');
    if (!btn) return;
    let left = Math.max(1, seconds | 0);
    const paint = () => {
        if (left <= 0) {
            clearInterval(authResendInterval);
            authResendInterval = null;
            btn.disabled = false;
            btn.innerText = 'Resend';
            return;
        }
        btn.disabled = true;
        btn.innerText = 'Resend in ' + left + 's';
        left--;
    };
    paint();
    authResendInterval = setInterval(paint, 1000);
}

function openAuth(mode) {
    authMode = (mode === 'register') ? 'register' : 'login';
    authStep = 'email';
    const modal = authEl('auth-modal');
    if (!modal) return;

    authEl('auth-title').innerText = authMode === 'register' ? 'Create Account' : 'Sign In';
    authEl('auth-tab-login').classList.toggle('active', authMode === 'login');
    authEl('auth-tab-register').classList.toggle('active', authMode === 'register');
    authEl('auth-step-code').style.display = 'none';
    authEl('auth-submit').innerText = 'Email Me a Code';
    authEl('auth-error').innerText = '';
    authEl('auth-code').value = '';
    stopResendTimer();
    modal.classList.add('show');
    setTimeout(() => { const el = authEl('auth-email'); if (el) el.focus(); }, 60);
}

function closeAuth() {
    const m = authEl('auth-modal');
    if (m) m.classList.remove('show');
    stopResendTimer();
}

function submitAuth(ev) {
    if (ev) ev.preventDefault();
    if (authStep === 'email') requestAuthCode();
    else verifyAuthCode();
    return false;
}

async function requestAuthCode() {
    const email = (authEl('auth-email').value || '').trim();
    const err = authEl('auth-error');
    const btn = authEl('auth-submit');
    err.innerText = '';
    if (!email) { err.innerText = 'Enter your email address.'; return false; }

    btn.disabled = true;
    try {
        const res = await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'request_code', email: email })
        });
        const data = await res.json();
        if (data.status !== 'success') {
            err.innerText = data.message || 'Could not send the code.';
            if (data.cooldown) startResendTimer(data.cooldown);
        } else {
            authStep = 'code';
            authEl('auth-step-code').style.display = 'block';
            authEl('auth-submit').innerText = 'Verify Code';
            authEl('auth-sent-to').innerText = 'Sent to ' + email;
            startResendTimer(data.cooldown || 60);
            playSound('ui_confirm');
            setTimeout(() => { const el = authEl('auth-code'); if (el) el.focus(); }, 60);
        }
    } catch (e) {
        err.innerText = 'Network error — please try again.';
    }
    btn.disabled = false;
    return false;
}

async function verifyAuthCode() {
    const email = (authEl('auth-email').value || '').trim();
    const code = (authEl('auth-code').value || '').replace(/\D/g, '');
    const err = authEl('auth-error');
    const btn = authEl('auth-submit');
    err.innerText = '';
    if (code.length !== 6) { err.innerText = 'Enter the 6-digit code from the email.'; return false; }

    btn.disabled = true;
    const body = new URLSearchParams({ action: 'verify_code', email: email, code: code });
    // Signing in mid-match: hand the seat over so this game counts too.
    if (state.roomCode && state.token) {
        body.set('room_code', state.roomCode);
        body.set('player_token', state.token);
    }
    try {
        const res = await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const data = await res.json();
        if (data.status !== 'success') {
            err.innerText = data.message || 'Could not sign you in.';
            playSound('ui_error');
        } else {
            applyAuthUser(data.user);
            adoptAccountNickname(data.user.name);
            closeAuth();
            playSound('ui_confirm');
            if (data.seat_linked && typeof appendSystemMessage === 'function') {
                appendSystemMessage('Signed in as ' + data.user.name + ' — this match now counts for your rank.');
            }
        }
    } catch (e) {
        err.innerText = 'Network error — please try again.';
    }
    btn.disabled = false;
    return false;
}

// If the player hasn't chosen a handle yet, use the account name in-game.
function adoptAccountNickname(name) {
    const el = authEl('nickname');
    if (!el || !name) return;
    if (/^player\d{5}$/.test((el.value || '').trim())) {
        el.value = name.slice(0, 20);
        try { localStorage.setItem('werewolf.nickname', el.value); } catch (e) {}
    }
}

async function doLogout() {
    try {
        await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'logout' })
        });
    } catch (e) {}
    applyAuthUser(null);
}

// The game screen has its own top bar whose Exit button already sits in the
// top-right corner, so move the account bar INTO that bar while it's on screen
// instead of letting the two overlap.
function placeAuthBar(screenId) {
    const bar = authEl('auth-bar');
    const topbar = document.querySelector('#view-game .game-topbar');
    if (!bar || !topbar) return;
    if (screenId === 'view-game') {
        if (bar.parentElement !== topbar) {
            topbar.appendChild(bar);
            bar.classList.add('in-topbar');
        }
    } else if (bar.parentElement !== document.body) {
        document.body.appendChild(bar);
        bar.classList.remove('in-topbar');
    }
}

function initAuth() {
    // Six digits in -> submit, no need to reach for the button.
    const code = authEl('auth-code');
    if (code) {
        code.addEventListener('input', () => {
            if ((code.value || '').replace(/\D/g, '').length === 6 && authStep === 'code') verifyAuthCode();
        });
        code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitAuth(ev); });
    }
    const email = authEl('auth-email');
    if (email) email.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitAuth(ev); });
    refreshAuth();
}
