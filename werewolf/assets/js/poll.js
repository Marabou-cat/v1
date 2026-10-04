/* werewolf / poll — game polling + main render loop
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= POLLING ================= */
        // How long the server may hold an idle poll open (ms).  The client
        // re-polls the moment a response lands, so this only bounds the
        // worst-case "nothing is happening" request rate (~1 per 1.2s — the same
        // as the old fixed 1.5s interval) while keeping bot/phase advancement
        // ticking.  Any real change returns within the server's ~200ms check.
        const POLL_WAIT_MS = 1200;

        function startGamePolling() {
            document.getElementById('display-room-code').innerText = state.roomCode;
            document.getElementById('game-room-code').innerText = state.roomCode;
            state.pollSig = '';
            gamePollLoop();
        }

        // One poll.  Asks the server to HOLD the request until something changes
        // (long-poll) and hands back the state fingerprint to wait against.
        async function gamePollOnce() {
            const body = new URLSearchParams({
                action: 'poll_game', room_code: state.roomCode, token: state.token,
                wait: POLL_WAIT_MS
            });
            if (state.pollSig) body.set('sig', state.pollSig);
            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            });
            {
                const data = await res.json();
                // A response that lands AFTER we left the table must be dropped whole.
                // The room is still 'ended'/'night' server-side for a moment after we
                // leave, and the game-screen branch below re-opened it on top of the
                // menu — which made "Back to Menu" look like it had not worked.
                if (!state.roomCode) return;
                if (data.state_sig) state.pollSig = data.state_sig;
                if (data.status !== 'success') {
                    // Room dissolved (everyone left) — drop back to the menu.
                    if (data.message === 'Room collapsed.') {
                        leaveToMenu();
                    }
                    return;
                }

                // Keep the latest payload around so optimistic action handlers can
                // mutate it and survive an incidental re-render (see actions.js).
                state.lastGame = data;

                // Shared server clock + phase anchors (drive the match timer
                // and the pre-night chat countdown identically on every client).
                applyServerClock(data);
                if (data.mm_started_at) state.mmStartedAt = data.mm_started_at;
                if (data.started_at) state.gameStartedAt = data.started_at;
                if (data.my_id) state.myId = data.my_id;
                // Account state rides the poll, so rank changes show up live.
                if ('me' in data) applyAuthUser(data.me);
                // Your own HP pill (Chaos Night only; hides itself otherwise).
                renderVitals(data);
                // The bite: claw marks + red smoke while wolves are on this seat.
                renderClaw(data);

                // Matchmaking wait strip (countdown + bot-fill indicator).
                updateMmStatus(data);

                // Render incoming messages from database (incrementally:
                // append only new ones, and only auto-scroll if the user is
                // already near the bottom — never yank them while reading up)
                if (data.messages) {
                    const chatMsgs = document.getElementById('chat-messages');
                    const known = parseInt(chatMsgs.dataset.lastCount || '0', 10);
                    const total = data.messages.length;
                    const lastM = data.messages[total - 1] || {};
                    // Signature of the newest message: the backend caps the
                    // list at 50, so past that the count stops changing and
                    // only this signature can detect the window shifting.
                    const lastSig = total + ':' + (lastM.sender_name || '') + '|' + (lastM.message || '');
                    if (total === 0) {
                        if (known !== 0) {
                            // Server side is empty (fresh match): restore the
                            // local welcome line
                            chatMsgs.innerHTML = '<div class="chat-message no-anim"><span class="sender">System:</span> Welcome to Werewolf Online! Talk before night falls.</div>';
                            chatMsgs.dataset.lastCount = '0';
                            chatMsgs.dataset.lastSig = '';
                        }
                    } else if (chatMsgs.dataset.lastSig !== lastSig) {
                        const nearBottom = (chatMsgs.scrollHeight - chatMsgs.scrollTop - chatMsgs.clientHeight) < 90;
                        const safeAppend = total > known && known < 40;
                        if (safeAppend) {
                            const fresh = data.messages.slice(Math.max(0, known));
                            // Soft bong for incoming chat, but not for my own echo.
                            if (fresh.some(m => m.sender_name !== state.nickname)) playSound('chat');
                            const html = fresh.map(m => `
                                <div class="chat-message"><span class="sender">${esc(m.sender_name)}:</span> ${m.message}</div>
                            `).join('');
                            if (html) chatMsgs.insertAdjacentHTML('beforeend', html);
                        } else {
                            // Reset (new match), window shift, first paint, or
                            // near the 50-cap: full rebuild, statically (no
                            // entrance animation replay on the history)
                            chatMsgs.innerHTML = data.messages.map(m => `<div class="chat-message no-anim"><span class="sender">${esc(m.sender_name)}:</span> ${m.message}</div>`).join('');
                        }
                        chatMsgs.dataset.lastCount = total;
                        chatMsgs.dataset.lastSig = lastSig;
                        trimChat(chatMsgs);
                        if (nearBottom) chatMsgs.scrollTop = chatMsgs.scrollHeight;
                        lucide.createIcons();
                    }
                }

                // Voice: keep peer connections in sync with the roster and
                // consume any WebRTC signalling relayed through this poll.
                if (data.players) syncVoicePeers(data.players);
                if (data.voice_signals && data.voice_signals.length) handleVoiceSignals(data.voice_signals);

                // Phase-change fade + night blackout + the death card.
                const prevStatus = state.lastRoomStatus || '';
                if (prevStatus !== data.room_status) {
                    // Force a clean roster rebuild on every phase flip. The
                    // optimistic lock (lockChoice) mutates the roster DOM directly,
                    // so without this a leftover "Chosen" from the night action
                    // could survive into the day vote. Same trick chat-timer uses.
                    const gpl = document.getElementById('game-player-list');
                    if (gpl) { gpl.dataset.fullSig = ''; gpl.dataset.rosterSig = ''; }
                    if ((prevStatus === 'night' && data.room_status === 'day') ||
                        (prevStatus === 'day' && data.room_status === 'night')) {
                        playPhaseTransition(data.room_status);
                    }
                    if (prevStatus === 'day' && data.room_status === 'night') {
                        // The village has just tallied: cut to the result
                        // (executed / tied / abstained) before night takes over.
                        showVoteCutscene(data.last_vote);
                        playSound('night_fall');       // the wolf howl
                    }
                    if (prevStatus === 'night' && data.room_status === 'day') {
                        playSound('day_break');        // dawn bell
                    }
                    if (prevStatus === 'lobby' && data.room_status === 'night') {
                        // New match: reset per-game death / blackout state.
                        state.lastAlive = true;
                        state.deathShown = false;
                        state.spectating = false;
                        const dEl = document.getElementById('death-overlay');
                        if (dEl) dEl.classList.remove('show');
                        playSound('game_start');
                    }
                    if (data.room_status === 'ended') {
                        // Either side can win, and guests have no recorded result,
                        // so derive it from the winning side + my own role.
                        const villagersWon = /Villagers win/i.test(data.last_event || '');
                        const iWon = (data.my_role === 'Werewolf') ? !villagersWon : villagersWon;
                        playSound(iWon ? 'victory' : 'defeat', { volume: 0.8 });
                    }
                    state.lastRoomStatus = data.room_status;
                }
                // Music follows the phase (no-op when the track is unchanged).
                updateBgmForScreen('view-game', data.room_status);
                updateNightUI(data);
                updateDeathUI(data);

                if (data.room_status === 'lobby') {
                    setPhase('lobby');
                    const lobbyVisible = !document.getElementById('view-lobby').classList.contains('hidden');
                    if (!lobbyVisible) return; // matching screen drives itself via updateMmStatus

                    document.getElementById('player-count').innerText = data.current_count;
                    document.getElementById('player-max').innerText = data.max_players;

                    // Doorbell for the lobby roster.
                    const prevCount = state.lobbyCount || 0;
                    if (prevCount && data.current_count > prevCount) playSound('join');
                    else if (prevCount && data.current_count < prevCount) playSound('leave');
                    state.lobbyCount = data.current_count;

                    renderRosterList(document.getElementById('player-list-ui'), data, null, 'lobby');

                    if (data.role_breakdown) {
                        const b = data.role_breakdown;
                        document.getElementById('lobby-role-breakdown').innerHTML = `
                            <strong>Squad Allocation (${data.current_count} Players):</strong><br>
                            <span class="role-tag"><i data-lucide="skull" size="16" style="color: #ff4d4d;"></i> ${b.werewolves} Werewolf</span>
                            <span class="role-tag"><i data-lucide="sparkles" size="16" style="color: var(--accent-gold);"></i> ${b.specials} Specials</span>
                            <span class="role-tag"><i data-lucide="shield" size="16" style="color: #38bdf8;"></i> ${b.villagers} Villagers</span>
                        `;
                        lucide.createIcons();
                    }

                    const startBtn = document.getElementById('btn-start-game');
                    const hostControls = document.getElementById('host-controls');
                    if (data.is_host) {
                        hostControls.style.display = 'flex';
                        const canStart = data.current_count >= 4;
                        startBtn.disabled = !canStart;
                        startBtn.classList.toggle('btn-start-ready', canStart);
                    } else {
                        hostControls.style.display = 'none';
                    }
                } else {
                    const viewGame = document.getElementById('view-game');
                    if (viewGame.classList.contains('hidden')) {
                        // While the matching->game cutscene is playing, ignore
                        // ticks so we don't double-transition mid-fade.
                        if (state.matchTransitioning) return;
                        const fromMatching = state.isMatch
                            && !document.getElementById('view-matching').classList.contains('hidden');
                        state.isMatch = false;
                        state.mmStartTs = null;
                        if (fromMatching) {
                            // Coming off the matching screen: play the
                            // "Entering Arena" cutscene, then drop into game.
                            state.matchTransitioning = true;
                            triggerCutscene('scene_door_open', () => {
                                state.matchTransitioning = false;
                                showScreen('view-game');
                                startPreNightChat();
                            });
                            return; // let the cutscene callback drive the rest
                        }
                        showScreen('view-game');
                        startPreNightChat();
                        // fall through to render the game below (existing flow)
                    }

                    setPhase(data.room_status);

                    // Night skill panel (Seer/Witch/Doctor) — hides itself off-night.
                    renderSkillPanel(data);

                    const roleDisplay = document.getElementById('my-role-display');
                    if (roleDisplay.dataset.role !== data.my_role) {
                        roleDisplay.dataset.role = data.my_role;
                        roleDisplay.innerHTML = `${setRoleIcon(data.my_role)} ${data.my_role}`;
                        lucide.createIcons();
                    }

                    if (data.last_event && data.last_event !== state.lastEvent) {
                        state.lastEvent = data.last_event;
                        // One character at a time, fast (see combat.js).
                        typewriteEvent(data.last_event);
                        flashEventBanner();
                    }

                    const phaseText = document.getElementById('game-phase-text');
                    const gameListLabel = document.getElementById('game-list-label');
                    const gamePlayerList = document.getElementById('game-player-list');

                    // Handle Pre-Night 15s chat window override
                    if (state.inPreNightChat && data.room_status === 'night') {
                        phaseText.innerHTML = '<i data-lucide="message-square" size="18" style="vertical-align: middle;"></i> Opening Chat Phase';
                        phaseText.style.color = 'var(--accent-gold)';
                        gameListLabel.innerText = 'Squad Roster (Talking before night):';
                        renderRosterList(gamePlayerList, data, null, 'pre-night');
                        return; // Skip standard night targeting until timer elapses
                    }

                    if (data.room_status === 'night') {
                        phaseText.innerHTML = '<i data-lucide="moon" size="18" style="vertical-align: middle;"></i> Night Phase';
                        phaseText.style.color = '#ff4d4d';

                        // Tell the player what their own role can do tonight.
                        if (data.my_role === 'Werewolf' && data.is_alive) {
                            gameListLabel.innerText = data.has_voted ? '🔒 Target locked in! Waiting for others...' : 'Select a Victim to Eliminate:';
                        } else if (data.my_role === 'Seer' && data.is_alive) {
                            gameListLabel.innerText = data.my_check_target ? '🔮 Divination complete — waiting for others...' : 'Select a player to Divine:';
                        } else if (data.my_role === 'Witch' && data.is_alive && !data.my_poison_used) {
                            gameListLabel.innerText = (data.my_poison_target || data.my_poison_skip) ? '🧪 Decision made — waiting for others...' : 'Select a player to Poison (once per game):';
                        } else if ((data.my_role === 'Villager' || data.my_role === 'Doctor') && data.is_alive) {
                            gameListLabel.innerText = data.my_asleep ? '😴 You are asleep. Waiting for the night to pass...' : 'Bunk down — tap Sleep to get through the night:';
                        } else {
                            gameListLabel.innerText = 'Squad Members (Asleep):';
                        }

                        renderRosterList(gamePlayerList, data, (p) => {
                            const canAct = (data.is_alive && p.is_alive && p.id !== data.my_id);
                            if (!canAct) return '';

                            if (data.my_role === 'Werewolf') {
                                if (data.my_target_id === p.id) return `<button class="btn-action btn-voted" disabled><i data-lucide="check" size="16"></i> ${data.mode === 'chaos' ? 'Attacking' : 'Targeted'}</button>`;
                                return `<button class="btn-action btn-kill" onclick="submitNightAction(${p.id}, this)"><i data-lucide="crosshair" size="16"></i> ${data.mode === 'chaos' ? 'Attack' : 'Kill'}</button>`;
                            }
                            if (data.my_role === 'Seer') {
                                if (data.my_check_target) {
                                    return (data.my_check_target === p.id)
                                        ? `<button class="btn-action btn-voted" disabled><i data-lucide="check" size="16"></i> Divined</button>`
                                        : '';
                                }
                                return `<button class="btn-action" onclick="submitNightAction(${p.id}, this)"><i data-lucide="eye" size="16"></i> Divine</button>`;
                            }
                            if (data.my_role === 'Witch' && !data.my_poison_used) {
                                if (data.my_poison_target || data.my_poison_skip) {
                                    return (data.my_poison_target === p.id)
                                        ? `<button class="btn-action btn-voted" disabled><i data-lucide="check" size="16"></i> Poisoned</button>`
                                        : '';
                                }
                                return `<button class="btn-action btn-kill" onclick="submitNightAction(${p.id}, this)"><i data-lucide="flask-conical" size="16"></i> Poison</button>`;
                            }
                            // Chaos Night: the Doctor takes a real action — a BLIND
                            // heal of one player. They are never told whether that
                            // player actually needed it.
                            if (data.my_role === 'Doctor' && data.mode === 'chaos') {
                                if (data.my_heal_target === p.id) return `<button class="btn-action btn-voted" disabled><i data-lucide="check" size="16"></i> Treating</button>`;
                                return `<button class="btn-action" onclick="submitNightAction(${p.id}, this)"><i data-lucide="heart-pulse" size="16"></i> Heal</button>`;
                            }
                            return '';
                        }, 'night');

                        renderSkillPanel(data);
                    } else if (data.room_status === 'day') {
                        phaseText.innerHTML = '<i data-lucide="sun" size="18" style="vertical-align: middle;"></i> Day Voting Phase';
                        phaseText.style.color = 'var(--accent-gold)';

                        gameListLabel.innerText = data.my_vote_skip
                            ? '🔒 You abstained — waiting for the tally...'
                            : (data.has_voted ? '🔒 Vote cast! Waiting for results...' : (data.is_alive ? 'Cast Your Vote to Lynch:' : 'Squad Roster (You are eliminated):'));

                        renderSkillPanel(data);   // day = vote panel + Skip Vote

                        renderRosterList(gamePlayerList, data, (p) => {
                            const canVote = (data.is_alive && p.is_alive);
                            const isVoteTarget = (data.my_vote_id === p.id);
                            if (!canVote) return '';
                            if (isVoteTarget) return `<button class="btn-action btn-voted" disabled><i data-lucide="check" size="16"></i> Voted</button>`;
                            return `<button class="btn-action" onclick="submitDayVote(${p.id}, this)"><i data-lucide="vote" size="16"></i> Vote</button>`;
                        }, 'day');
                    } else if (data.room_status === 'ended') {
                        phaseText.innerHTML = '<i data-lucide="trophy" size="18" style="vertical-align: middle;"></i> Match Concluded';
                        phaseText.style.color = '#38bdf8';

                        // Signed-in players see what the match did to their rank;
                        // guests are told that signing in is what counts.
                        const d = data.my_rating_delta;
                        const xp = data.my_xp_delta;
                        if (data.my_user_id && d !== null && d !== undefined) {
                            gameListLabel.innerText = (data.my_user_won ? 'Victory' : 'Defeat')
                                + '  ·  Rank ' + (d >= 0 ? '+' : '') + d
                                + (xp ? '  ·  +' + xp + ' XP' : '');
                        } else if (!data.my_user_id) {
                            gameListLabel.innerText = 'Final Squad Roster:  (sign in to earn rank & XP)';
                        } else {
                            gameListLabel.innerText = 'Final Squad Roster:';
                        }

                        // End-of-match settlement: winner reveal + role list +
                        // the two callouts. Idempotent, so the poll can call it
                        // on every ended frame.
                        showVictoryOverlay(data);

                        // Every role is revealed by the backend at 'ended', so the
                        // card's role chip renders it — no extra markup needed.
                        renderRosterList(gamePlayerList, data, null, 'ended');
                    }
                }
            }
        }

        // Self-scheduling poll loop: re-issue the moment the previous response
        // lands (the server already did the waiting), so updates arrive within
        // ~200ms of a change.  The floor delay keeps a fast-failing server from
        // turning this into a hot loop.
        async function gamePollLoop() {
            state.pollRunning = true;
            while (state.pollRunning) {
                const t0 = Date.now();
                try {
                    await gamePollOnce();
                } catch (e) {
                    await new Promise(r => setTimeout(r, 500));
                }
                const spent = Date.now() - t0;
                // A response that came back fast means "something changed" — the
                // old 150ms floor then added 150ms of dead time right when the
                // player wanted the update. 40ms is just enough to not hammer.
                if (spent < 40) await new Promise(r => setTimeout(r, 40 - spent));
            }
        }

        
