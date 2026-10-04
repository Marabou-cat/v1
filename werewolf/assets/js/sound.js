/* werewolf / sound — SFX + per-phase background music, driven by user settings.
   All audio is self-hosted under assets/audio/ (no CDN):
     · Kenney.nl packs — CC0 (public domain)
     · OpenGameArt tracks — CC0
   See assets/audio/CREDITS.md. */

const SOUND_CFG_KEY = 'werewolf.sound';

const sound = {
    cfg: { sfx: true, music: true, muteOthers: false, sfxVolume: 0.65, musicVolume: 0.30 },
    unlocked: false,     // browsers block autoplay until the first gesture
    bgm: null,
    bgmName: '',
    bases: {}
};

function soundLoadCfg() {
    try {
        const raw = localStorage.getItem(SOUND_CFG_KEY);
        if (raw) Object.assign(sound.cfg, JSON.parse(raw));
    } catch (e) {}
    soundApplyMuteOthers();
}

function soundSaveCfg() {
    try { localStorage.setItem(SOUND_CFG_KEY, JSON.stringify(sound.cfg)); } catch (e) {}
}

document.addEventListener('keydown', soundUnlock, true);

// Autoplay policy: nothing plays until the user interacts once.
function soundUnlock() {
    if (sound.unlocked) return;
    sound.unlocked = true;
    if (sound.cfg.music && sound.bgmName && sound.bgm) sound.bgm.play().catch(() => {});
}

function playSound(name, opts) {
    if (!sound.cfg.sfx || !name) return;
    try {
        const base = sound.bases[name] || (sound.bases[name] = new Audio('assets/audio/' + name + '.mp3'));
        const a = base.cloneNode();
        a.volume = Math.max(0, Math.min(1, (opts && opts.volume !== undefined) ? opts.volume : sound.cfg.sfxVolume));
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
    } catch (e) { /* audio is never allowed to break the game */ }
}

// Background music. Called with a track name ('bgm_menu' | 'bgm_day' | 'bgm_night')
// or null to stop. Changing to the same track is a no-op so the loop survives.
function playBgm(name) {
    if (sound.bgmName === name) return;
    sound.bgmName = name;
    if (!sound.bgm) {
        sound.bgm = new Audio();
        sound.bgm.loop = true;
        sound.bgm.volume = 0;
    }
    clearInterval(sound.bgmFade);
    if (!name) {
        sound.bgm.pause();
        return;
    }
    sound.bgm.src = 'assets/audio/' + name + '.mp3';
    if (!sound.cfg.music || !sound.unlocked) return;
    sound.bgm.currentTime = 0;
    sound.bgm.play().catch(() => {});
    soundFadeIn();
}

// Gentle fade-in so phase changes don't stab the ear.
function soundFadeIn() {
    const target = sound.cfg.musicVolume;
    clearInterval(sound.bgmFade);
    sound.bgm.volume = 0;
    sound.bgmFade = setInterval(() => {
        if (!sound.bgm) return clearInterval(sound.bgmFade);
        const v = sound.bgm.volume + 0.04;
        if (v >= target) { sound.bgm.volume = target; clearInterval(sound.bgmFade); }
        else sound.bgm.volume = v;
    }, 60);
}

// Toggle music on/off without losing the current track position.
function soundApplyMusic() {
    if (!sound.bgm) return;
    if (sound.cfg.music) {
        if (sound.bgmName && sound.unlocked) { sound.bgm.play().catch(() => {}); soundFadeIn(); }
    } else {
        clearInterval(sound.bgmFade);
        sound.bgm.pause();
    }
}

// "Mute other players" silences incoming voice (our own mic stays live).
function soundApplyMuteOthers() {
    try {
        const els = (window.state && state.voice && state.voice.audioEls) || {};
        Object.keys(els).forEach(k => { if (els[k]) els[k].muted = !!sound.cfg.muteOthers; });
    } catch (e) {}
}

// One click handler for the whole UI: every button gets a click sound.
document.addEventListener('click', (ev) => {
    soundUnlock();
    const btn = ev.target && ev.target.closest && ev.target.closest('button, .menu-btn, .btn-action, .player-item');
    if (!btn) return;
    if (btn.disabled) return;
    if (btn.id === 'settings-btn' || btn.classList.contains('auth-close')) playSound('ui_hover');
    else if (btn.classList.contains('danger') || btn.classList.contains('exit-btn')) playSound('leave');
    else playSound('ui_click');
}, true);

// The lobby/game sound design: which music belongs to which phase.
function updateBgmForScreen(screenId, roomStatus) {
    if (screenId && screenId !== 'view-game') { playBgm('bgm_menu'); return; }
    if (roomStatus === 'night') playBgm('bgm_night');
    else if (roomStatus === 'day') playBgm('bgm_day');
    else if (roomStatus === 'lobby') playBgm('bgm_menu');
    else if (roomStatus === 'ended') playBgm(null);
}
