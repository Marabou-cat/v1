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
        // No speaker name here: the action panel at the bottom already names who holds
        // the floor and counts them down, so repeating it inside the input read as a
        // duplicate. The dialog box now only states YOUR state.
        input.placeholder = (t.step === 'lastwords')
            ? 'Listen to the last words…'
            : 'You are muted — wait for your turn…';
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


/* ===========================================================================
   #6  THE COMPOSER NEVER LEAVES. The chat panel used to be
   `max-height: 30vh; overflow: hidden`, so the talk bar + the quick-phrase row
   pushed the input past the clip line and it simply vanished mid-turn.
   #4  SKIP moves next to the team box, and only exists while a ballot or a night
   action is actually open (day vote / night actions).
   #5  Five seconds before a seat's turn the next speaker is flagged "up next" and,
   when that seat is yours, the bar counts you in.
   =========================================================================== */

function talkGame() { return state.lastGame || {}; }
function talkNow() { return state.talk || {}; }

function talkSecondsLeft() {
    const t = talkNow();
    if (!t.ends_at) return null;
    return Math.max(0, Math.round(t.ends_at - Date.now() / 1000));
}

/* Who holds the floor next, or null when the round is about to close. */
function talkNextSpeaker() {
    const g = talkGame();
    const order = g.talk_order || [];
    const i = (typeof g.talk_index === 'number') ? g.talk_index : -1;
    if (!order.length || i < 0) return null;
    return order[i + 1] || null;
}

/* ---- #5 the "up next" cue -------------------------------------------------- */
function renderTalkReady() {
    const g = talkGame(), t = talkNow();
    const active = (typeof talkActive === 'function') && talkActive();
    const left = talkSecondsLeft();
    const next = talkNextSpeaker();

    // mark the next seat's card so the table can see who speaks next
    const cards = document.querySelectorAll('.d-pcard');
    for (let i = 0; i < cards.length; i++) cards[i].classList.remove('d-next');
    if (active && next && left !== null && left <= 5) {
        const c = document.querySelector('.d-pcard[data-pid="' + next + '"]');
        if (c) c.classList.add('d-next');
    }

    let el = document.getElementById('talk-ready');
    const iAmNext = !!(next && g.my_id && next === g.my_id);
    const show = active && left !== null && left <= 5 && (iAmNext || !!next);
    if (!show) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('div');
        el.id = 'talk-ready';
        const host = document.getElementById('chat-container');
        const composer = document.getElementById('chat-composer');
        if (!host) return;
        host.insertBefore(el, composer || null);
    }
    el.className = iAmNext ? 'ready me' : 'ready';
    el.innerHTML = (iAmNext
        ? '<i data-lucide="mic" size="14"></i> Get ready to speak'
        : '<i data-lucide="hourglass" size="14"></i> Next up: ' + esc(String((talkGame().talk_next_name) || 'someone')))
        + ' <b>' + left + '</b>';
    if (window.lucide) lucide.createIcons();
}

/* ---- #4 skip, beside the team box, only when there is something to skip ----- */
function renderSkipNearTeam() {
    // CSS-only from here on. The native #btn-skip must stay inside the composer row it
    // was born in: yanking it out broke the site's own enable/disable lookup, which is
    // why it went unclickable even during the vote. This function now only UNDOES my
    // earlier relocation, so any stale strip repairs itself on the next tick.
    const mine = document.getElementById('d-skip-near');
    if (mine) mine.remove();
    const strip = document.getElementById('d-skip-strip');
    if (strip) {
        const btn = document.getElementById('btn-skip');
        const composer = document.getElementById('chat-composer');
        if (btn && composer && btn.parentElement === strip) composer.insertBefore(btn, composer.firstChild);
        strip.remove();
    }
}

setInterval(function () {
    try { renderTalkReady(); } catch (e) {}
    try { renderSkipNearTeam(); } catch (e) {}
}, 400);
