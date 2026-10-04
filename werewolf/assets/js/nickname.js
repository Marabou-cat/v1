/* werewolf / nickname — the in-game handle.

   Signed in  -> the handle lives ON THE ACCOUNT (server-side), so it follows the
                 player between devices and browsers. Edits are saved debounced.
   Signed out -> nothing is persisted anywhere. A fresh "playerNNNNN" default is
                 minted on every page load, and again on sign-out. */

// Default handle: "player" followed by 5 random digits.
function randomNickname() {
    return 'player' + Math.floor(10000 + Math.random() * 90000);
}

function nicknameField() { return document.getElementById('nickname'); }

// What the field should show right now for the current identity.
function defaultNicknameForIdentity() {
    const u = state.authUser;
    if (u) return (u.nickname && u.nickname !== '') ? u.nickname : u.name;
    return randomNickname();
}

let nicknameSaveTimer = null;

// Only accounts persist a nickname. Guests are deliberately NOT stored anywhere,
// so they fall back to a default next time they open the page.
function queueNicknameSave(value) {
    if (!state.authUser) return;
    clearTimeout(nicknameSaveTimer);
    nicknameSaveTimer = setTimeout(() => {
        fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'set_nickname', nickname: value })
        }).then(r => r.json()).then(d => {
            if (d.status === 'success' && d.user) {
                state.authUser = d.user;
                state.authSig = '';        // force a repaint with the saved handle
                applyAuthUser(d.user);
            }
        }).catch(() => {});
    }, 700);
}

// Called from applyAuthUser() when the signed-in IDENTITY changes (sign in or
// sign out) — never on every poll, so it can't fight what the player is typing.
function syncNicknameField() {
    const el = nicknameField();
    if (!el) return;
    const u = state.authUser;
    const owner = u ? u.id : null;
    if (state.nicknameOwner === owner) return;
    state.nicknameOwner = owner;
    el.value = defaultNicknameForIdentity();
}

function initNickname() {
    const el = nicknameField();
    if (!el) return;
    // Start as a guest with a fresh default; refreshAuth() swaps in the account
    // handle if there's a session.
    el.value = randomNickname();
    state.nicknameOwner = null;
    el.addEventListener('input', () => queueNicknameSave(el.value.trim()));
    el.addEventListener('change', () => queueNicknameSave(el.value.trim()));
}
