/* werewolf / actions — day vote / night action posts
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= ACTIONS ================= */
        async function submitNightAction(targetId, btn) {
            // Acknowledge the tap before the write: see feedback.js for why.
            if (btn) { lockChoice(document.getElementById('game-player-list'), btn); markCardActed(btn); }
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

            // --- Day: the vote panel (pick a target above, or abstain) ---------
            if (data.room_status === 'day') {
                if (!data.is_alive) { el.style.display = 'none'; el.innerHTML = ''; return; }
                el.style.display = 'block';
                if (data.my_vote_skip) {
                    el.innerHTML = `
                        <div class="skill-head"><i data-lucide="skip-forward" size="18"></i> Vote Skipped</div>
                        <div class="skill-body">You abstained. Waiting for the rest of the village…</div>`;
                } else if (data.has_voted) {
                    el.innerHTML = `
                        <div class="skill-head"><i data-lucide="check" size="18"></i> Vote Cast</div>
                        <div class="skill-body">Waiting for the rest of the village…</div>`;
                } else {
                    el.innerHTML = `
                        <div class="skill-head"><i data-lucide="vote" size="18"></i> Cast Your Vote</div>
                        <div class="skill-body">Pick a player above to lynch — or abstain. A tie for the most votes, or a majority of abstentions, means nobody is executed.</div>
                        <div class="skill-actions"><button class="btn-action" onclick="submitDayVoteSkip(this)"><i data-lucide="skip-forward" size="16"></i> Skip Vote</button></div>`;
                }
                lucide.createIcons();
                return;
            }

            const active = (data.room_status === 'night') && !state.inPreNightChat && !!data.is_alive;
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
                const isWolf = data.my_seer_result === 'wolf';
                el.style.display = 'block';
                el.innerHTML = `
                    <div class="skill-head"><i data-lucide="eye" size="18"></i> Seer — Divination</div>
                    <div class="skill-body">Your vision of <b>${data.my_seer_target_name}</b>:
                        <b style="color:${isWolf ? '#ff4d4d' : '#38bdf8'};">${isWolf ? 'WEREWOLF 🐺' : 'not a werewolf ✅'}</b></div>`;
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
            if (g) { g.my_vote_id = voteId; g.has_voted = true; g.my_vote_skip = 0; }
            if (btn) {
                lockChoice(document.getElementById('game-player-list'), btn);
                markCardActed(btn);
            }
            const label = document.getElementById('game-list-label');
            if (label) label.innerText = '🔒 Vote cast! Waiting for results...';
            playSound('vote_cast');
            flashInfo('Vote locked in');

            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'day_vote', room_code: state.roomCode, token: state.token, vote_id: voteId })
            });
            const data = await res.json();
            if (data.status !== 'success') {
                // Roll the optimistic paint back so the UI never lies.
                if (g) { g.my_vote_id = null; g.has_voted = false; }
                playSound('ui_error');
                flashInfo(data.message, true);
                state.pollSig = '';       // '' disables the long wait -> fresh render now
            }
        }

        // Abstain. Tallied as a "skip" vote: if abstentions outnumber the most
        // voted-for player, nobody is executed.
        async function submitDayVoteSkip(btn) {
            const g = state.lastGame;
            if (g) { g.my_vote_skip = 1; g.has_voted = true; g.my_vote_id = null; }
            if (btn) btn.disabled = true;
            const label = document.getElementById('game-list-label');
            if (label) label.innerText = '🔒 You abstained — waiting for the tally...';
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

        
