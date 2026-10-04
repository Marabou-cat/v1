/* werewolf / avatar — the account-bound identity badge.
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see assets/index.html script tags). */

/* ================= AVATARS =================
   Ids are what the SERVER stores (users.avatar / players.avatar); this table
   only maps an id to a look. Glyphs come from the SELF-HOSTED lucide bundle
   (assets/lucide.min.js) — never a CDN — and the colours live in CSS custom
   properties so one markup string works everywhere. */
const AVATARS = {
    paw:    { icon: 'paw-print', c1: '#fbbf24', c2: '#b45309', label: 'Amber Paw' },
    moon:   { icon: 'moon-star', c1: '#a5b4fc', c2: '#4338ca', label: 'Moonlit' },
    skull:  { icon: 'skull',     c1: '#cbd5e1', c2: '#475569', label: 'Ash Skull' },
    ghost:  { icon: 'ghost',     c1: '#67e8f9', c2: '#0e7490', label: 'Spirit' },
    blade:  { icon: 'swords',    c1: '#fca5a5', c2: '#991b1b', label: 'Blade' },
    ember:  { icon: 'flame',     c1: '#fdba74', c2: '#c2410c', label: 'Ember' },
    warden: { icon: 'shield',    c1: '#93c5fd', c2: '#1d4ed8', label: 'Warden' },
    royal:  { icon: 'crown',     c1: '#fde68a', c2: '#b45309', label: 'Royal' },
    seer:   { icon: 'eye',       c1: '#d8b4fe', c2: '#6b21a8', label: 'Seer' },
    hunter: { icon: 'crosshair', c1: '#86efac', c2: '#15803d', label: 'Hunter' },
    raven:  { icon: 'bird',      c1: '#a5b4fc', c2: '#3730a3', label: 'Raven' },
    cat:    { icon: 'cat',       c1: '#f9a8d4', c2: '#9d174d', label: 'Cat' },
    hound:  { icon: 'dog',       c1: '#fdba74', c2: '#9a3412', label: 'Hound' },
    bone:   { icon: 'bone',      c1: '#e2e8f0', c2: '#64748b', label: 'Bone' },
    forest: { icon: 'tree-pine', c1: '#6ee7b7', c2: '#047857', label: 'Forest' },
    frost:  { icon: 'snowflake', c1: '#bae6fd', c2: '#0369a1', label: 'Frost' },
};

const AVATAR_FALLBACK = 'paw';

function avatarDef(id) {
    return AVATARS[id] || AVATARS[AVATAR_FALLBACK];
}

/* A round badge. Rendered with <i data-lucide> so it reuses the one self-hosted
   icon bundle; the caller must run lucide.createIcons() after inserting. */
function avatarHtml(id, size) {
    const d = avatarDef(id);
    const s = size || 28;
    const glyph = Math.round(s * 0.58);
    return '<span class="avatar" style="width:' + s + 'px;height:' + s + 'px;'
        + '--av-a:' + d.c1 + ';--av-b:' + d.c2 + ';" title="' + esc(d.label) + '">'
        + '<i data-lucide="' + d.icon + '" size="' + glyph + '"></i>'
        + '</span>';
}

/* The picker grid (settings panel). Only shown to SIGNED-IN players: the avatar
   belongs to the account, so a guest has nothing to attach one to. */
function avatarPickerHtml(current, size) {
    const s = size || 34;
    return Object.keys(AVATARS).map(function (k) {
        const d = AVATARS[k];
        return '<span class="avatar avatar-pick' + (k === current ? ' on' : '') + '"'
            + ' data-av="' + k + '" title="' + esc(d.label) + '"'
            + ' style="width:' + s + 'px;height:' + s + 'px;--av-a:' + d.c1 + ';--av-b:' + d.c2 + ';"'
            + ' onclick="pickAvatar(\'' + k + '\')">'
            + '<i data-lucide="' + d.icon + '" size="' + Math.round(s * 0.58) + '"></i></span>';
    }).join('');
}

/* Paint first, save after: the badge updates on the spot so the tap feels
   instant, and the server write confirms in the background. */
function pickAvatar(id) {
    if (!AVATARS[id]) return;
    if (!state.authUser) {
        flashInfo('Sign in to choose an avatar — it lives on your account.');
        return;
    }
    if (state.authUser.avatar === id) return;
    const prev = state.authUser.avatar;
    state.authUser.avatar = id;
    state.authSig = '';                 // force the top bar to repaint
    applyAuthUser(state.authUser);
    if (typeof renderSettingsAccount === 'function') renderSettingsAccount();
    if (window.lucide) lucide.createIcons();
    playSound('ui_click');

    fetch('backend.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'set_avatar', avatar: id })
    }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || d.status !== 'success') throw new Error((d && d.message) || 'failed');
        if (d.user) { state.authUser = d.user; state.authSig = ''; applyAuthUser(d.user); }
        if (typeof renderSettingsAccount === 'function') renderSettingsAccount();
        if (window.lucide) lucide.createIcons();
    }).catch(function () {
        // Roll the badge back so the UI never claims something that didn't save.
        state.authUser.avatar = prev;
        state.authSig = '';
        applyAuthUser(state.authUser);
        if (typeof renderSettingsAccount === 'function') renderSettingsAccount();
        if (window.lucide) lucide.createIcons();
        flashInfo('Could not save the avatar. Try again.', true);
    });
}
