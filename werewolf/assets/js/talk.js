/* werewolf / talk — the turn-based day discussion.
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags).

   The SERVER owns the rule (rooms.day_step / talk_order / talk_index) and rejects
   anything out of turn (handleSendMessage). This file only renders that state and
   keeps the microphone honest:

     lastwords -> each victim of the night speaks once, then is removed
     discuss   -> one speaker at a time, TALK_SECONDS each; nobody else talks
     vote      -> talking is CLOSED, only the lynch vote runs

   Muting is enforced in three places: the text gate is server-side, the mic is
   muted locally, and every client silences the peers who do NOT hold the turn —
   so even a doctored client cannot be heard. */

function talkActive() {
    const t = state.talk;
    const st = (state.lastGame || {}).room_status;
    return !!t && st === 'day' && (t.step === 'lastwords' || t.step === 'discuss');
}

// Outside a live match (lobby / post-game) the old open chat still applies.
function talkFreeForAll() {
    const st = (state.lastGame || {}).room_status;
    return !st || st === 'lobby' || st === 'ended' || st === 'matching';
}

// The remaining seconds of the current turn, on the SHARED server clock.
function talkRemaining() {
    const t = state.talk;
    if (!talkActive() || !t.ends_at) return 0;
    return Math.max(0, t.ends_at - serverNow());
}

// May I send a line / open my mic right now?
function talkCanISpeak() {
    if (talkFreeForAll()) return true;
    return talkActive() && !!(state.talk && state.talk.my_turn);
}

// Is this peer's audio allowed through? Only the player holding the turn talks.
function talkPeerAudible(peerId) {
    if (talkFreeForAll()) return true;
    const t = state.talk;
    return !!t && String(peerId) === String(t.speaker_id) && talkActive();
}

/* ---- called from the poll with the fresh payload ------------------------- */
function applyTalk(data) {
    if (!data) return;
    state.talk = {
        step: data.day_step || 'vote',
        speaker_id: parseInt(data.talk_speaker_id || 0, 10),
        speaker_name: data.talk_speaker_name || '',
        order: data.talk_order || [],
        index: parseInt(data.talk_index || 0, 10),
        total: parseInt(data.talk_total || 0, 10),
        started_at: parseInt(data.talk_started_at || 0, 10),
        ends_at: parseInt(data.talk_ends_at || 0, 10),
        seconds: parseInt(data.talk_seconds || 15, 10),
        my_turn: !!data.my_turn
    };
    renderTalkBar();
    renderTalkHighlight();
    applyTalkVoice();
    applyTalkComposer();
    // The quick-phrase row lives and dies with the floor (its own ticker is only a
    // safety net, so the row is never usable out of turn even for a moment).
    if (typeof renderQuickRow === 'function') renderQuickRow();
}

/* ---- the bar above the chat composer -------------------------------------- */
function ensureTalkBar() {
    let bar = document.getElementById('talk-bar');
    if (bar) return bar;
    const host = document.getElementById('chat-container');
    if (!host) return null;
    bar = document.createElement('div');
    bar.id = 'talk-bar';
    bar.className = 'd-talkbar';
    const composer = document.getElementById('chat-composer');
    host.insertBefore(bar, composer || null);
    return bar;
}

function renderTalkBar() {
    const bar = ensureTalkBar();
    if (!bar) return;
    if (!talkActive()) { bar.classList.remove('show'); bar.innerHTML = ''; return; }

    const t = state.talk;
    const rem = talkRemaining();
    const who = talkFreeForAll() ? '' : (t.my_turn ? 'Your turn to speak' : (t.speaker_name ? t.speaker_name + ' is speaking' : 'Someone is speaking'));
    const step = (t.step === 'lastwords') ? 'LAST WORDS' : ('DISCUSSION ' + (t.index + 1) + '/' + t.total);

    bar.innerHTML =
        '<span class="d-talk-who"><i data-lucide="' + (t.my_turn ? 'mic' : 'volume-2') + '" size="15"></i> ' + esc(who) + '</span>'
        + '<span class="d-talk-time' + (rem <= 5 ? ' low' : '') + '">' + rem + 's</span>'
        + (t.my_turn ? '<button class="btn-action" onclick="endMyTalk()"><i data-lucide="check" size="15"></i> Done</button>' : '')
        + '<span class="d-talk-step">' + step + '</span>';
    bar.classList.add('show');
    if (window.lucide) lucide.createIcons();
}

// Glow the card of whoever holds the turn. Re-applied on a timer because the poll
// re-renders the roster and would otherwise drop the class.
function renderTalkHighlight() {
    const on = talkActive() && !!(state.talk && state.talk.speaker_id);
    const want = on ? String(state.talk.speaker_id) : '';
    const cur = document.querySelector('.d-pcard.d-speaking');
    if (cur && (!on || cur.dataset.pid !== want)) cur.classList.remove('d-speaking');
    if (!on) return;
    const card = document.querySelector('.d-pcard[data-pid="' + want + '"]');
    if (card && !card.classList.contains('d-speaking')) card.classList.add('d-speaking');
}

/* ---- microphone + incoming peers ------------------------------------------ */
function applyTalkVoice() {
    if (typeof state.voice === 'undefined' || !state.voice) return;
    // My own mic: open ONLY while I hold the turn (unless I muted myself).
    if (state.voice.stream) {
        const allow = talkCanISpeak() && !state.voice.muted;
        state.voice.stream.getAudioTracks().forEach(tr => { tr.enabled = allow; });
    }
    // Everybody else: only the current speaker is audible.
    Object.keys(state.voice.audioEls || {}).forEach(pid => {
        const el = state.voice.audioEls[pid];
        if (!el) return;
        const hard = !!(typeof sound !== 'undefined' && sound.cfg && sound.cfg.muteOthers);
        el.muted = talkPeerAudible(pid) ? hard : true;
    });
    if (typeof renderVoiceBar === 'function') renderVoiceBar();
}

/* ---- the composer --------------------------------------------------------- */
function applyTalkComposer() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const can = talkCanISpeak();
    const t = state.talk || {};
    input.disabled = !can;
    if (can) {
        input.placeholder = talkActive() ? 'Your turn — say something…' : 'Type your message...';
    } else if (talkActive()) {
        input.placeholder = (t.step === 'lastwords')
            ? (t.speaker_name || 'The victim') + ' is giving their last words…'
            : (t.speaker_name || 'Someone') + ' is speaking — you are muted';
    } else {
        input.placeholder = 'Talking is closed — wait for the discussion';
    }
}

/* ---- I am done talking ---------------------------------------------------- */
async function endMyTalk() {
    if (!talkActive() || !state.talk.my_turn) return;
    const btn = document.querySelector('#talk-bar .btn-action');
    if (btn) btn.disabled = true;
    try {
        await fetch('backend.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'end_talk', room_code: state.roomCode, token: state.token })
        });
    } catch (e) {}
    state.talk.my_turn = false;                    // optimistic: the next poll confirms
    renderTalkBar();
}

// Countdown ticker. Cheap: one text node + one class check, 4x a second.
setInterval(function () {
    if (talkActive()) { renderTalkBar(); renderTalkHighlight(); }
}, 250);
