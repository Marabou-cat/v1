/* werewolf / auth — optional accounts, top-right sign in / sign up, rank display.
   Guests are first-class: nothing here is needed to play, it only unlocks the
   win rate and rank. */

let authMode = 'login';

function authTierClass(tier) {
    return 'tier-' + String(tier || 'Bronze').toLowerCase();
}

// Repaint the top-right bar for a signed-in user, or back to the guest buttons.
function applyAuthUser(u) {
    const guest = document.getElementById('auth-guest');
    const user  = document.getElementById('auth-user');
    if (!guest || !user) return;
    state.authUser = (u && u.name) ? u : null;

    // The poll calls this every tick; only touch the DOM when something useful
    // actually changed.
    const sig = state.authUser
        ? [u.name, u.tier, u.rating, u.games, u.wins].join('|')
        : '';
    if (sig === state.authSig) return;
    state.authSig = sig;

    if (state.authUser) {
        guest.style.display = 'none';
        user.style.display = 'flex';
        // Rank emblem instead of text; the tier name rides the tooltip.
        const tier = document.getElementById('auth-tier');
        tier.innerHTML = rankIconSvg(u.tier);
        tier.title = u.tier;
        document.getElementById('auth-name').innerText = u.name;
        document.getElementById('auth-stats').innerText = u.games > 0
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

function openAuth(mode) {
    authMode = (mode === 'register') ? 'register' : 'login';
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    document.getElementById('auth-title').innerText = authMode === 'register' ? 'Create Account' : 'Log In';
    document.getElementById('auth-submit').innerText = authMode === 'register' ? 'Sign Up' : 'Log In';
    document.getElementById('auth-tab-login').classList.toggle('active', authMode === 'login');
    document.getElementById('auth-tab-register').classList.toggle('active', authMode === 'register');
    document.getElementById('auth-password').setAttribute('autocomplete', authMode === 'register' ? 'new-password' : 'current-password');
    document.getElementById('auth-error').innerText = '';
    modal.classList.add('show');
    setTimeout(() => { const el = document.getElementById('auth-username'); if (el) el.focus(); }, 60);
}

function closeAuth() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.remove('show');
}

async function submitAuth(ev) {
    if (ev) ev.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const err = document.getElementById('auth-error');
    const btn = document.getElementById('auth-submit');
    err.innerText = '';
    btn.disabled = true;

    const body = new URLSearchParams({ action: authMode, username: username, password: password });
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
            err.innerText = data.message || 'Something went wrong.';
        } else {
            applyAuthUser(data.user);
            closeAuth();
            document.getElementById('auth-password').value = '';
            if (data.seat_linked && typeof appendSystemMessage === 'function') {
                appendSystemMessage('Signed in — this match now counts for your rank.');
            }
        }
    } catch (e) {
        err.innerText = 'Network error — please try again.';
    }
    btn.disabled = false;
    return false;
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
    const bar = document.getElementById('auth-bar');
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
    refreshAuth();
}
