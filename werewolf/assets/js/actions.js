/* werewolf / actions — day vote / night action posts
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= ACTIONS ================= */
        async function submitNightAction(targetId, btn) {
            // Acknowledge the tap before the write: see feedback.js for why.
            if (btn) {
                lockChoice(document.getElementById('game-player-list'), btn);
                markCardActed(btn);
                // Only the pack gets the bite animation — the Seer's and Doctor's
                // buttons post through this same handler.
                const g = state.lastGame;
                if (g && g.my_role === 'Werewolf') clawSlash(btn);
            }
            playSound('ui_click');
            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'night_action', room_code: state.roomCode, token: state.token, target_id: targetId })
            });
            const data = await res.json();
            if (data.status !== 'success') { playSound('ui_error'); flashInfo(data.message, true); state.pollSig = ''; }
            else flashInfo('Choice locked in');
        }

        async function submitNightSkip(btn) {
            if (btn) btn.disabled = true;
            playSound('ui_click');
            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'night_action', room_code: state.roomCode, token: state.token, skip: 1 })
            });
            const data = await res.json();
            if (data.status !== 'success') { playSound('ui_error'); flashInfo(data.message, true); state.pollSig = ''; }
        }

        async function submitDoctorAction(revive, btn) {
            if (btn) { btn.disabled = true; btn.classList.add('is-pressed'); }
            playSound('ui_click');
            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'doctor_action', room_code: state.roomCode, token: state.token, revive: revive ? 1 : 0 })
            });
            const data = await res.json();
            if (data.status !== 'success') { playSound('ui_error'); flashInfo(data.message, true); state.pollSig = ''; }
        }

        async function submitSleep() {
            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'night_action', room_code: state.roomCode, token: state.token, sleep: 1 })
            });
            const data = await res.json();
            if (data.status !== 'success') alert(data.message);
            else playSound('sleep');
        }
        function renderSkillPanel(data) {
            const el = document.getElementById('skill-panel');
            if (!el) return;

            // --- Day: no skill banner. Vote by tapping a player; skip via the
            // bottom "Skip" button (submitDayVoteSkip). ---
            if (data.room_status === 'day') {
                el.style.display = 'none'; el.innerHTML = '';
                return;
            }

            // Note: the pre-night chat window must NOT suppress actions. The centred
            // Sleep button is only gated by role/asleep, so gating the panel here left
            // the special roles with no way to act for the first 15s of every match.
            const active = (data.room_status === 'night') && !!data.is_alive;
            if (!active) { el.style.display = 'none'; el.innerHTML = ''; return; }

            // Doctor: the prompt appears only while the night waits on us.
            if (data.my_role === 'Doctor' && data.night_step === 'doctor' && data.doctor_victim_name) {
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="cross" size="18"></i> Doctor — Night Vision</div>
                    <div class="skill-body">Tonight the werewolves are about to kill <b style="color:#ff4d4d;">${data.doctor_victim_name}</b>. Use your one revive?</div>
                    <div class="skill-actions">
                        <button class="btn-action btn-kill" onclick="submitDoctorAction(1, this)"><i data-lucide="heart-pulse" size="16"></i> Revive (once per game)</button>
                        <button class="btn-action" onclick="submitDoctorAction(0, this)"><i data-lucide="x" size="16"></i> Let them die</button>
                    </div>`;
                lucide.createIcons();
                return;
            }

            // Villager / Doctor (outside the doctor step): tap Sleep. Everyone who
            // has no night action must tap it, which also masks the sound of the
            // werewolf's kill tap when friends are on a voice call.
            // Chaos Night: the Doctor's action is a BLIND heal (Heal buttons live
            // on the roster) plus the option to hold the medicine. They are never
            // told whether the player they treated actually needed it.
            if (data.my_role === 'Doctor' && data.mode === 'chaos') {
                const treating = !!data.my_heal_target;
                const held = (Number(data.my_doctor_choice) === 0);
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="heart-pulse" size="18"></i> Doctor — Treat</div>
                    <div class="skill-body">${treating
                        ? 'You have chosen who to treat. You will never be told whether it helped.'
                        : (held ? 'You are holding your medicine tonight.'
                                : 'Pick a player above to treat — or hold your medicine. Nobody tells you who needed it.')}</div>
                    ${(!treating && !held)
                        ? '<div class="skill-actions"><button class="btn-action" onclick="submitNightSkip(this)"><i data-lucide="moon" size="16"></i> Hold medicine</button></div>'
                        : ''}`;
                lucide.createIcons();
                return;
            }

            if ((data.my_role === 'Villager' || data.my_role === 'Doctor') && !data.my_asleep) {
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="moon" size="18"></i> Sleep</div>
                    <div class="skill-body">Tap <b>Sleep</b> to get through the night — everyone taps, so on a voice call nobody can tell who acted.</div>
                    <div class="skill-actions"><button class="btn-action" onclick="submitSleep()"><i data-lucide="moon" size="16"></i> Sleep</button></div>`;
                lucide.createIcons();
                return;
            }
            if ((data.my_role === 'Villager' || data.my_role === 'Doctor') && data.my_asleep) {
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="moon" size="18"></i> Sleeping</div>
                    <div class="skill-body">You are asleep. Waiting for the night to pass...</div>`;
                lucide.createIcons();
                return;
            }

            // Seer: show the most recent divination.
            if (data.my_role === 'Seer' && data.my_seer_result) {
                // Chaos Night: the Seer reads the REAL role and the CURRENT HP —
                // the only way anyone ever sees another player's numbers.
                if (data.mode === 'chaos') {
                    const r = String(data.my_seer_result);
                    const isWolf = (r === 'Werewolf');
                    el.style.display = 'block';
                    el.innerHTML = `
                        <div class="skill-head"><i data-lucide="eye" size="18"></i> Seer — Read</div>
                        <div class="skill-body">You read <b>${esc(data.my_seer_target_name)}</b>:<br>
                            <b style="color:${isWolf ? '#ff4d4d' : '#38bdf8'};">${esc(r)}</b>
                            <span class="seer-hp">· ${data.my_seer_hp} HP</span></div>`;
                    lucide.createIcons();
                    return;
                }
                const isWolf = data.my_seer_result === 'wolf';
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="eye" size="18"></i> Seer — Divination</div>
                    <div class="skill-body">Your vision of <b>${data.my_seer_target_name}</b>:
                        <b style="color:${isWolf ? '#ff4d4d' : '#38bdf8'};">${isWolf ? '<i data-lucide="paw-print" size="15"></i> WEREWOLF' : '<i data-lucide="shield-check" size="15"></i> not a werewolf'}</b></div>`;
                lucide.createIcons();
                return;
            }

            // Witch: explain the one-shot poison and allow an explicit pass.
            if (data.my_role === 'Witch') {
                let body;
                if (data.my_poison_used) {
                    body = 'Your poison has been spent for this game.';
                } else if (data.my_poison_target) {
                    body = 'You have marked who to poison tonight.';
                } else if (data.my_poison_skip) {
                    body = 'You chose not to poison anyone tonight.';
                } else {
                    body = 'You hold one poison for the whole game. Pick a player above, or pass tonight.';
                }
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="flask-conical" size="18"></i> Witch — Poison</div>
                    <div class="skill-body">${body}</div>
                    ${(!data.my_poison_used && !data.my_poison_target && !data.my_poison_skip)
                        ? '<div class="skill-actions"><button class="btn-action" onclick="submitNightSkip(this)"><i data-lucide="moon" size="16"></i> Pass tonight</button></div>'
                        : ''}`;
                lucide.createIcons();
                return;
            }

            el.style.display = 'none';
            el.innerHTML = '';
        }

        async function submitDayVote(voteId, btn) {
            // Optimistic: paint the vote NOW. The server has to commit a durable
            // write (~270ms fsync) before it can answer, and making the player
            // stare at an unchanged screen for that long reads as "broken".
            const g = state.lastGame;
            // Belt and braces: never paint an optimistic vote for your own seat.
            if (g && voteId === g.my_id) { flashInfo('You cannot vote for yourself.', true); return; }
            const prevVoteId = g ? g.my_vote_id : null;
            // Move the TALLY locally right now, so the count under the card updates
            // on the same frame as the tap (the server's authoritative tally arrives
            // with this request's response and overwrites it). Re-pointing a vote
            // also has to give the old target its vote back.
            let undo = null;
            if (g && g.players) {
                const prev = (prevVoteId && prevVoteId !== voteId) ? g.players.find(p => p.id === prevVoteId) : null;
                const target = g.players.find(p => p.id === voteId);
                undo = { prev: prev, prevVotes: prev ? (prev.votes || 0) : null,
                         target: target, targetVotes: target ? (target.votes || 0) : null };
                if (prev && prev.votes > 0) prev.votes = prev.votes - 1;
                if (target) target.votes = (target.votes || 0) + 1;
            }
            if (g) { g.my_vote_id = voteId; g.has_voted = true; g.my_vote_skip = 0; }
            if (btn) {
                lockChoice(document.getElementById('game-player-list'), btn, 'Voted');
                markCardActed(btn);
            }
            if (typeof dRepaintVoteChips === 'function') dRepaintVoteChips(g);
            const label = document.getElementById('game-list-label');
            if (label) { label.innerHTML = '<i data-lucide="lock" size="15"></i> Vote cast! Waiting for results...'; if (window.lucide) lucide.createIcons(); }
            playSound('vote_cast');
            flashInfo('Vote locked in');

            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'day_vote', room_code: state.roomCode, token: state.token, vote_id: voteId })
            });
            const data = await res.json();
            if (data.status !== 'success') {
                // Roll the optimistic paint back — vote mark AND tally — so the UI
                // never lies about who is about to be executed.
                if (undo) {
                    if (undo.prev && undo.prevVotes !== null) undo.prev.votes = undo.prevVotes;
                    if (undo.target && undo.targetVotes !== null) undo.target.votes = undo.targetVotes;
                }
                if (g) { g.my_vote_id = prevVoteId; g.has_voted = false; }
                if (typeof dRepaintVoteChips === 'function') dRepaintVoteChips(g);
                playSound('ui_error');
                flashInfo(data.message, true);
                state.pollSig = '';       // '' disables the long wait -> fresh render now
            } else if (data.votes && g && g.players) {
                // The response carries the authoritative live tally — adopt it
                // immediately instead of waiting for the next poll frame.
                g.players.forEach(function (p) {
                    if (data.votes[p.id] !== undefined) p.votes = data.votes[p.id];
                });
                if (typeof dRepaintVoteChips === 'function') dRepaintVoteChips(g);
            }
        }

        // Abstain. Tallied as a "skip" vote: if abstentions outnumber the most
        // voted-for player, nobody is executed.
        async function submitDayVoteSkip(btn) {
            const g = state.lastGame;
            if (g) { g.my_vote_skip = 1; g.has_voted = true; g.my_vote_id = null; }
            if (btn) btn.disabled = true;
            const label = document.getElementById('game-list-label');
            if (label) { label.innerHTML = '<i data-lucide="lock" size="15"></i> You abstained — waiting for the tally...'; if (window.lucide) lucide.createIcons(); }
            playSound('vote_cast', { volume: 0.5 });
            flashInfo('Abstained');

            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'day_vote', room_code: state.roomCode, token: state.token, skip: 1 })
            });
            const data = await res.json();
            if (data.status !== 'success') {
                if (g) { g.my_vote_skip = 0; g.has_voted = false; }
                playSound('ui_error');
                flashInfo(data.message, true);
                state.pollSig = '';
            }
        }

        


/* ================= SKIP THIS ROUND (bottom bar button) =================
   One button, phase-aware: abstain the vote by day, sleep / pass / hold
   by night. Seer and Werewolf have no skipable action. */
function skipRound(btn) {
    const g = state.lastGame;
    if (!g) return;
    const st = g.room_status;
    if (st === 'day') {
        if (g.has_voted || g.my_vote_skip) { flashInfo('You already voted'); return; }
        submitDayVoteSkip(btn);
    } else if (st === 'night') {
        const r = g.my_role;
        if (r === 'Villager') {
            if (g.my_asleep) { flashInfo('Already asleep'); return; }
            submitSleep();
        } else if (r === 'Doctor') {
            if (g.night_step === 'doctor' && !g.my_doctor_choice) { submitDoctorAction(0, btn); }
            else if (g.mode === 'chaos') { submitNightSkip(btn); }
            else { submitSleep(); }
        } else if (r === 'Witch') {
            if (g.my_poison_used || g.my_poison_target || g.my_poison_skip) { flashInfo('Poison already decided'); return; }
            submitNightSkip(btn);
        } else if (r === 'Werewolf') {
            // Hold the bite. Was falling through to "No action to skip this phase":
            // the pack simply had no way to pass, which stalled short-handed nights.
            if (g.my_target_id) { flashInfo('Bite already chosen'); return; }
            submitNightSkip(btn);
        } else if (r === 'Seer') {
            if (g.my_target_id) { flashInfo('Your vision is already chosen'); return; }
            submitNightSkip(btn);
        } else {
            flashInfo('No action to skip this phase');
        }
    } else {
        flashInfo('Nothing to skip right now');
    }
}
