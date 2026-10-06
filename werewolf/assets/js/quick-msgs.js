/* werewolf / quick-msgs — one-tap table talk for your turn.
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags).

   The row only appears while you actually hold the floor (talkCanISpeak()), so it
   can never be used to talk out of turn, and it sends through the very same
   `send_message` action as the composer — the server's turn gate still applies.

   Target phrases open a second row: LIVING seats (never yourself) for {player},
   and the claimable roles for {role}. The role list is deliberately NOT your real
   role: a claim is a claim, and a wolf has to be able to lie. */

const QUICK_PHRASES = [
    { key: 'suspect', label: 'I suspect…',                   pick: 'player', text: 'I suspect {player}.' },
    { key: 'notwolf', label: "I'm not the werewolf.",        text: "I'm not the werewolf." },
    { key: 'iam',     label: 'I am the…',                    pick: 'role',   text: 'I am the {role}.' },
    { key: 'voteout', label: 'Vote out…',                    pick: 'player', text: 'Vote out {player}.' },
    { key: 'noinfo',  label: 'I have no information.',       text: 'I have no information.' },
    { key: 'whosus',  label: 'Who do you suspect?',          text: 'Who do you suspect?' },
    { key: 'askrole', label: 'What is your role?',           pick: 'player', text: '{player}, what is your role?' },
    { key: 'with',    label: "I'm with…",                    pick: 'player', text: "I'm with {player}." },
    { key: 'asleep',  label: 'I was asleep, saw nothing.',   text: 'I was asleep — I saw nothing.' },
];

// Roles you may CLAIM. Werewolf is left out: nobody claims the pack.
const CLAIMABLE_ROLES = ['Villager', 'Seer', 'Witch', 'Doctor', 'Hunter'];

function quickPending() { return state.quickPending || null; }

function ensureQuickRow() {
    let row = document.getElementById('quick-msgs');
    if (row) return row;
    const host = document.getElementById('chat-container');
    if (!host) return null;
    row = document.createElement('div');
    row.id = 'quick-msgs';
    row.className = 'd-quick';
    const composer = document.getElementById('chat-composer');
    host.insertBefore(row, composer || null);
    return row;
}

/* Shown only when you may speak; collapses the picker whenever the floor is lost. */
function renderQuickRow() {
    const row = ensureQuickRow();
    if (!row) return;
    const can = (typeof talkCanISpeak === 'function') ? talkCanISpeak() : false;
    if (!can) {
        if (state.quickPending) state.quickPending = null;
        row.classList.remove('show');
        row.innerHTML = '';
        return;
    }
    row.classList.add('show');
    const pending = quickPending();

    // --- second step: pick a target / a claim ---------------------------------
    if (pending && pending.step === 'player') {
        const me = (state.lastGame && state.lastGame.my_id) || state.myId;
        const targets = ((state.lastGame && state.lastGame.players) || [])
            .filter(p => p.is_alive && p.id !== me);
        row.innerHTML = '<span class="q-hint">Say it about…</span>'
            + targets.map(p => '<button class="d-qchip" onclick="quickPickPlayer(' + p.id + ')">' + esc(p.nickname) + '</button>').join('')
            + '<button class="d-qchip q-back" onclick="quickCancel()">Cancel</button>';
        if (window.lucide) lucide.createIcons();
        return;
    }
    if (pending && pending.step === 'role') {
        row.innerHTML = '<span class="q-hint">Claim…</span>'
            + CLAIMABLE_ROLES.map(r => '<button class="d-qchip" onclick="quickPickRole(\'' + r + '\')">' + r + '</button>').join('')
            + '<button class="d-qchip q-back" onclick="quickCancel()">Cancel</button>';
        if (window.lucide) lucide.createIcons();
        return;
    }

    // --- first step: the phrases ---------------------------------------------
    row.innerHTML = '<span class="q-hint"><i data-lucide="zap" size="13"></i></span>'
        + QUICK_PHRASES.map(p => '<button class="d-qchip" onclick="quickTap(\'' + p.key + '\')">' + esc(p.label) + '</button>').join('');
    if (window.lucide) lucide.createIcons();
}

function quickTap(key) {
    const p = QUICK_PHRASES.filter(x => x.key === key)[0];
    if (!p) return;
    if (p.pick === 'player') { state.quickPending = { step: 'player', key: key }; renderQuickRow(); return; }
    if (p.pick === 'role')   { state.quickPending = { step: 'role',   key: key }; renderQuickRow(); return; }
    quickSend(p.text);
}

function quickPickPlayer(pid) {
    const pend = quickPending();
    const p = QUICK_PHRASES.filter(x => x.key === (pend && pend.key))[0];
    const who = (((state.lastGame || {}).players) || []).filter(x => x.id === pid)[0];
    if (!p || !who) { quickCancel(); return; }
    quickSend(p.text.replace('{player}', who.nickname));
}

function quickPickRole(role) {
    const pend = quickPending();
    const p = QUICK_PHRASES.filter(x => x.key === (pend && pend.key))[0];
    if (!p) { quickCancel(); return; }
    quickSend(p.text.replace('{role}', role));
}

function quickCancel() { state.quickPending = null; renderQuickRow(); }

/* One tap = one line. Same endpoint as the composer, so the turn gate applies. */
async function quickSend(text) {
    if (typeof talkCanISpeak === 'function' && !talkCanISpeak()) {
        if (typeof flashInfo === 'function') flashInfo('Not your turn to speak.', true);
        quickCancel();
        return;
    }
    state.quickPending = null;
    renderQuickRow();
    try {
        await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'send_message', room_code: state.roomCode, token: state.token, message: text })
        });
    } catch (e) {}
}

setInterval(renderQuickRow, 400);
