/* werewolf / avatar-builder — build your own character.
   ---------------------------------------------------------------------------
   A layered paper-doll. Every part is a solid silhouette SVG used as a CSS MASK,
   so ONE file per shape serves every colour: hair is a shape + a colour, not 70
   pre-coloured files, and recolouring is instant.

   Because all parts were authored against one reference geometry
   (make_avatar_parts.py: 120x120, head at 60,60 r24), any combination lines up —
   which is the whole point: the hair has to sit on the body it is worn with.

   The result is packed into a short code that fits the EXISTING avatar column
   (VARCHAR(32)), so nothing else in the stack has to change: the hall, the seat,
   the payload and the roster already just pass an avatar id around.

     v1 b B h s e r R y w m x X        <- 14 chars, 12 one-char fields
        ^ body  ^ head  ^ ears ^ hair  ^ eyes/brows/mouth  ^ extra
*/

const AV_AB = '0123456789abcdefghijklmnopqrstuvwxyz';

const AVATAR_PARTS = {
    body:  ['cloak', 'tunic', 'armor'],
    head:  ['round', 'oval', 'square'],
    ears:  ['none', 'wolf', 'small', 'tuft'],
    hair:  ['bald', 'short', 'long', 'pony', 'bun', 'mohawk', 'wild'],
    brows: ['neutral', 'angry', 'worried', 'raised'],
    eyes:  ['calm', 'angry', 'sad', 'closed', 'wide'],
    mouth: ['neutral', 'smile', 'frown', 'grim'],
    extra: ['none', 'hood', 'pointed', 'helm', 'horns', 'mask', 'crown'],
};

// Palettes. Skin runs from pale to deep plus two fantasy tones so the cast is not
// all one hue; the clothing/extra ramps keep the set looking like one wardrobe.
const AV_SKIN  = ['#f6ddc4', '#f2d3b3', '#e8b98f', '#c9926a', '#8d5a3b', '#5c3a25', '#a9c7a0', '#b9a0d4'];
const AV_HAIR  = ['#3a2a1c', '#20242c', '#b06a1f', '#e9c86a', '#8d3b3b', '#b8433f', '#8a6fc4', '#4f9a6a', '#e8e2d4'];
const AV_CLOTH = ['#4f7fb8', '#b8433f', '#4f9a6a', '#c08a3e', '#8a6fc4', '#3f9aa6', '#7c8b9c', '#2f3a4d', '#c26a34', '#e9c86a'];
const AV_EXTRA = ['#3a4356', '#5b3a7a', '#7c2d2d', '#2f3a4d', '#8d6a2a', '#4a4a52', '#e9c86a'];
const AV_EYE   = ['#12151f', '#3b2a1a', '#1f3a2a', '#2a1f3a'];

const AV_KEY = 'werewolf_avatar_cfg';

function isCustomAvatar(id) { return typeof id === 'string' && id.indexOf('v1') === 0 && id.length === 14; }

function defaultAvatarCfg() {
    return { b: 0, B: 0, h: 0, s: 2, e: 0, r: 1, R: 0, y: 0, w: 0, m: 0, x: 0, X: 0 };
}

function avatarCodeToCfg(code) {
    const cfg = defaultAvatarCfg();
    if (!isCustomAvatar(code)) return cfg;
    const keys = ['b', 'B', 'h', 's', 'e', 'r', 'R', 'y', 'w', 'm', 'x', 'X'];
    for (let i = 0; i < keys.length; i++) {
        const v = AV_AB.indexOf(code.charAt(2 + i));
        cfg[keys[i]] = v < 0 ? cfg[keys[i]] : v;
    }
    return cfg;
}

function cfgToAvatarCode(c) {
    const keys = ['b', 'B', 'h', 's', 'e', 'r', 'R', 'y', 'w', 'm', 'x', 'X'];
    let out = 'v1';
    for (let i = 0; i < keys.length; i++) {
        const n = AV_AB[Math.max(0, Math.min(35, c[keys[i]] | 0))];
        out += n;
    }
    return out;
}

/* One layer of the doll.
   The mask goes in the INLINE style on purpose: a relative url() inside a CSS
   custom property is resolved against the STYLESHEET it is substituted in, which
   turned these into /assets/css/assets/img/... and 404'd every layer. Inline
   styles resolve against the document, so the path stays correct. */
function avLayer(slot, shape, color) {
    if (!shape) return '';
    const u = 'assets/img/avatar/' + slot + '_' + shape + '.svg';
    return '<i class="av-layer" style="background:' + color
        + ';-webkit-mask-image:url(' + u + ');mask-image:url(' + u + ')"></i>';
}

/* hex (#rrggbb) -> rgba() at the given alpha, for tinting the token's glow. */
function avRgba(hex, a) {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* Compose the doll from a code (or from a working config object). */
function customAvatarHtml(code, size) {
    const c = (typeof code === 'object') ? code : avatarCodeToCfg(code);
    const s = size || 28;
    const skin = AV_SKIN[c.s % AV_SKIN.length];
    const hair = AV_HAIR[c.R % AV_HAIR.length];
    const cloth = AV_CLOTH[c.B % AV_CLOTH.length];
    const ears = AVATAR_PARTS.ears[c.e];
    // Wolf/tuft ears are FUR, so they follow the hair colour rather than the skin —
    // a black-haired wolf gets black ears. Little detail, big difference.
    const earCol = (c.e === 1 || c.e === 3) ? hair : skin;
    // The token glows in the character's OWN outfit colour. Without it the round
    // frame read as a dark, empty hole around the figure — the preset portraits get
    // that glow from their baked-in gradient, so a built one has to carry it too.
    const glow = 'radial-gradient(circle at 50% 32%, ' + avRgba(cloth, 0.42)
        + ' 0%, rgba(18,21,31,0.98) 60%, #0b0d13 100%)';
    return '<span class="avatar av-custom" style="width:' + s + 'px;height:' + s + 'px;background:' + glow + '" title="Custom character">'
        + avLayer('body', AVATAR_PARTS.body[c.b], cloth)
        + avLayer('head', AVATAR_PARTS.head[c.h], skin)
        + avLayer('ears', ears, earCol)
        + avLayer('hair', AVATAR_PARTS.hair[c.r], hair)
        + avLayer('brows', AVATAR_PARTS.brows[c.w], hair)          // brows match the hair
        + avLayer('eyes', AVATAR_PARTS.eyes[c.y], AV_EYE[c.y % AV_EYE.length])
        + avLayer('mouth', AVATAR_PARTS.mouth[c.m], '#3a2020')
        + avLayer('extra', AVATAR_PARTS.extra[c.x], AV_EXTRA[c.X % AV_EXTRA.length])
        + '</span>';
}

/* ================= THE BUILDER =================
   Body / Hair / Face / Extras, each with its shapes and its colours, over a live
   preview. Guests get this too — the hall is where they pick a face, and there is
   no account needed to build one. */
/* Tabs. Each option row is [config key, asset slot, label, shapes] — the KEY is the
   one-char field in the code ('b' for body), the SLOT is the file prefix
   (body_cloak.svg). Conflating the two made the Body tab silently write to a field
   the codec never reads, so clicking those options did nothing. */
const AV_TABS = [
    { id: 'body',  label: 'Body',   icon: 'shirt',
      opts: [['b', 'body', 'Shape', AVATAR_PARTS.body], ['h', 'head', 'Head', AVATAR_PARTS.head]],
      cols: [['B', 'Outfit', AV_CLOTH], ['s', 'Skin', AV_SKIN]] },
    { id: 'hair',  label: 'Hair',   icon: 'scissors',
      opts: [['r', 'hair', 'Style', AVATAR_PARTS.hair], ['e', 'ears', 'Ears', AVATAR_PARTS.ears]],
      cols: [['R', 'Hair colour', AV_HAIR]] },
    { id: 'face',  label: 'Face',   icon: 'smile',
      opts: [['y', 'eyes', 'Eyes', AVATAR_PARTS.eyes], ['w', 'brows', 'Brows', AVATAR_PARTS.brows],
             ['m', 'mouth', 'Mouth', AVATAR_PARTS.mouth]],
      cols: [['y', 'Eye colour', AV_EYE]] },
    { id: 'extra', label: 'Extras', icon: 'crown',
      opts: [['x', 'extra', 'Worn', AVATAR_PARTS.extra]],
      cols: [['X', 'Accessory', AV_EXTRA]] },
];

/* Slots drawn ON the head. Their tiles get a faint head behind them, otherwise a
   hairstyle is just a sliver at the top of the tile and unreadable. */
const AV_ON_HEAD = { hair: 1, ears: 1, brows: 1, eyes: 1, mouth: 1, extra: 1 };

let avTab = 0;

function avCfg() {
    if (!state.avatarCfg) state.avatarCfg = avatarCodeToCfg(hallLoad(AV_KEY) || '');
    return state.avatarCfg;
}

function avPick(key, val) {
    const c = avCfg();
    c[key] = val;
    // Eye colour is driven by the eye SHAPE slot parity only as a default; keep the
    // explicit choice the player made.
    renderAvatarBuilder();
    if (typeof playSound === 'function') playSound('ui_click');
}

/* Any change is applied IMMEDIATELY (live preview + hall + seat), not on Done. */
function avApply() {
    const code = cfgToAvatarCode(avCfg());
    state.hallChar = code;
    hallStore(AV_KEY, code);
    hallStore(HALL_KEY_AV, code);
    if (typeof renderHall === 'function') renderHall(state.lastHall || null);
    if (state.hallOn && typeof hallBeat === 'function') hallBeat();
    return code;
}

function avRandomise() {
    const r = function (n) { return Math.floor(Math.random() * n); };
    state.avatarCfg = {
        b: r(AVATAR_PARTS.body.length), B: r(AV_CLOTH.length),
        h: r(AVATAR_PARTS.head.length), s: r(AV_SKIN.length),
        e: r(AVATAR_PARTS.ears.length), r: r(AVATAR_PARTS.hair.length), R: r(AV_HAIR.length),
        y: r(AVATAR_PARTS.eyes.length), w: r(AVATAR_PARTS.brows.length), m: r(AVATAR_PARTS.mouth.length),
        x: r(AVATAR_PARTS.extra.length), X: r(AV_EXTRA.length)
    };
    renderAvatarBuilder();
    avApply();
    if (typeof playSound === 'function') playSound('ui_click');
}

function avSwatchRow(key, label, palette) {
    const cur = avCfg()[key];
    return '<div class="avb-row"><span class="avb-lab">' + label + '</span><span class="avb-swatches">'
        + palette.map(function (col, i) {
            return '<button class="avb-sw' + (i === cur ? ' on' : '') + '" style="background:' + col + '"'
                + ' onclick="avPick(\'' + key + '\',' + i + ')" title="' + col + '"></button>';
        }).join('')
        + '</span></div>';
}

function avOptRow(key, slot, label, list) {
    const cur = avCfg()[key];
    const ghost = AV_ON_HEAD[slot]
        ? '<i class="avb-ghosthead" style="background:rgba(226,232,240,0.3);'
          + '-webkit-mask-image:url(assets/img/avatar/head_round.svg);mask-image:url(assets/img/avatar/head_round.svg)"></i>'
        : '';
    return '<div class="avb-row"><span class="avb-lab">' + label + '</span><span class="avb-opts">'
        + list.map(function (shape, i) {
            const empty = (shape === 'none' || shape === 'bald');
            const u = 'assets/img/avatar/' + slot + '_' + shape + '.svg';
            return '<button class="avb-opt' + (i === cur ? ' on' : '') + '" onclick="avPick(\'' + key + '\',' + i + ')" title="' + shape + '">'
                + ghost
                + (empty
                    ? '<span class="avb-none">&times;</span>'
                    : '<i style="-webkit-mask-image:url(' + u + ');mask-image:url(' + u + ')"></i>')
                + '</button>';
        }).join('')
        + '</span></div>';
}

function renderAvatarBuilder() {
    const m = document.getElementById('avatar-builder');
    if (!m) return;
    const tab = AV_TABS[avTab];
    const body = tab.opts.map(function (o) { return avOptRow(o[0], o[1], o[2], o[3]); }).join('')
        + tab.cols.map(function (c) { return avSwatchRow(c[0], c[1], c[2]); }).join('');
    m.innerHTML = '<div class="avb-card">'
        + '<div class="avb-head"><h3>Build your character</h3>'
        + '<span class="avb-sub">Every part is shaped to fit the body it is worn with.</span></div>'
        + '<div class="avb-main">'
        + '<div class="avb-preview">' + customAvatarHtml(avCfg(), 150)
        + '<button class="avb-dice" onclick="avRandomise()" title="Surprise me">'
        + '<i data-lucide="dices" size="14"></i> Random</button></div>'
        + '<div class="avb-panel">'
        + '<div class="avb-tabs">' + AV_TABS.map(function (t, i) {
            return '<button class="avb-tab' + (i === avTab ? ' on' : '') + '" onclick="avTabGo(' + i + ')">'
                + '<i data-lucide="' + t.icon + '" size="13"></i>' + t.label + '</button>';
        }).join('') + '</div>'
        + '<div class="avb-body">' + body + '</div>'
        + '</div></div>'
        + '<div class="avb-foot">'
        + '<button class="avb-ghost" onclick="avRandomise()">Surprise me</button>'
        + '<button class="avb-done" onclick="closeAvatarBuilder()">Use this character</button>'
        + '</div></div>';
    if (window.lucide) lucide.createIcons();
}

function avTabGo(i) { avTab = i; renderAvatarBuilder(); }

function openAvatarBuilder() {
    let m = document.getElementById('avatar-builder');
    if (!m) {
        m = document.createElement('div');
        m.id = 'avatar-builder';
        m.className = 'char-picker';         // reuse the modal shell
        document.body.appendChild(m);
    }
    if (!state.avatarCfg) state.avatarCfg = avatarCodeToCfg(hallLoad(AV_KEY) || '');
    m.classList.add('show');
    renderAvatarBuilder();
}

function closeAvatarBuilder() {
    const code = avApply();
    // Signed in: keep it on the account too, so every device agrees.
    if (state.authUser && state.authUser.avatar !== code && typeof pickAvatar === 'function') pickAvatar(code);
    const m = document.getElementById('avatar-builder');
    if (m) m.classList.remove('show');
    if (typeof refreshHallSeat === 'function') refreshHallSeat();
}
