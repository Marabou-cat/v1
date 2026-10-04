/* werewolf / settings — sound effects, background music, mute others, and the
   sign-out (deliberately tucked in here rather than sitting on the top bar). */

const RANK_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master'];

// Rank emblem markup. The <symbol>s are inlined in index.html so CSS `color`
// tints them per tier; the source files live in assets/img/rank/.
function rankIconSvg(tier, extraClass) {
    const t = String(tier || 'bronze').toLowerCase();
    const key = RANK_TIERS.indexOf(t) >= 0 ? t : 'bronze';
    return '<svg class="rank-icon rank-' + key + (extraClass ? ' ' + extraClass : '') +
           '" viewBox="0 0 512 512" role="img" aria-label="' + key + '"><use href="#rank-' + key + '"/></svg>';
}

function setToggle(el, on) {
    if (!el) return;
    el.innerText = on ? 'On' : 'Off';
    el.classList.toggle('on', !!on);
}

function renderSettings() {
    setToggle(document.getElementById('set-sfx'), sound.cfg.sfx);
    setToggle(document.getElementById('set-music'), sound.cfg.music);
    setToggle(document.getElementById('set-mute'), sound.cfg.muteOthers);
    renderSettingsAccount();
    if (window.lucide) lucide.createIcons();
}

function renderSettingsAccount() {
    const box = document.getElementById('set-account');
    if (!box) return;
    const u = state.authUser;
    if (u) {
        const pct = Math.max(0, Math.min(100, Math.round((u.xp_progress || 0) * 100)));
        box.innerHTML =
            '<div class="set-account">' + rankIconSvg(u.tier, 'rank-lg') +
                '<div class="set-account-txt">' +
                    '<b>' + esc(u.name) + '</b>' +
                    '<span>' + esc(u.email || '') + '</span>' +
                    '<span>' + esc(u.tier) + ' · ' + u.rating + ' · ' + u.wins + 'W-' + u.losses + 'L · ' + u.win_rate + '%</span>' +
                '</div>' +
            '</div>' +
            '<div class="xp-wrap">' +
                '<div class="xp-track"><div class="xp-fill" style="width:' + pct + '%"></div></div>' +
                '<div class="xp-text"><span>Level ' + (u.level || 1) + '</span>' +
                    '<span>' + (u.xp_into || 0) + ' / ' + (u.xp_need || 0) + ' XP</span></div>' +
            '</div>' +
            '<div class="set-avatar-head">Avatar <span>tap to change</span></div>' +
            '<div class="avatar-grid">' + avatarPickerHtml(u.avatar, 34) + '</div>' +
            '<button class="set-signout" onclick="signOutFromSettings()">Sign out</button>';
    } else {
        box.innerHTML =
            '<p class="set-guest">Playing as a guest. Win rate, rank and <b>levels / XP</b> are locked — they live on an account.</p>' +
            '<button class="set-signout" onclick="closeSettings(); openAuth(\'register\')">Create an account</button>';
    }
    // The avatar grid is icon-based, so the glyphs need rendering after the
    // innerHTML swap (same reason the roster does it).
    if (window.lucide) lucide.createIcons();
}

function toggleSetting(key) {
    sound.cfg[key] = !sound.cfg[key];
    soundSaveCfg();
    if (key === 'music') soundApplyMusic();
    if (key === 'muteOthers') soundApplyMuteOthers();
    if (key === 'sfx' && sound.cfg.sfx) playSound('ui_confirm');
    renderSettings();
}

function openSettings() {
    renderSettings();
    const m = document.getElementById('settings-modal');
    if (m) m.classList.add('show');
}

function closeSettings() {
    const m = document.getElementById('settings-modal');
    if (m) m.classList.remove('show');
}

async function signOutFromSettings() {
    await doLogout();
    renderSettings();
    closeSettings();
}

function initSettings() {
    soundLoadCfg();
    renderSettings();
}
