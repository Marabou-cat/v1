/* werewolf / matchmaking — quick match flow
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= QUICK MATCH ================= */
        function openQuickMatch() {
            const nick = (document.getElementById('nickname').value || '').trim();
            if (!nick) {
                alert('Enter a nickname first.');
                return;
            }
            // Mode first (the picker continues to the size screen), so the queue
            // we join is always scoped to the chosen ruleset.
            openModePicker('match');
        }

        function updateMatchRolePreview() {
            const count = parseInt(document.getElementById('match-count').value, 10);
            const b = roleBreakdown(count, state.mode || 'classic');
            document.getElementById('match-role-info').innerHTML = `
                <strong>${esc(modeLabel(state.mode || 'classic'))} &middot; Squad Composition:</strong><br>
                <span class="role-tag" style="color: #ff4d4d;"><i data-lucide="skull" size="16"></i> Werewolves: ${b.wolves}</span>
                <span class="role-tag" style="color: var(--accent-gold);"><i data-lucide="sparkles" size="16"></i> Specials: ${b.specials}</span>
                <span class="role-tag" style="color: #38bdf8;"><i data-lucide="shield" size="16"></i> Villagers: ${b.villagers}</span>
            `;
            lucide.createIcons();
        }

        function enterMatchLobby(data) {
            state.roomCode = data.room_code;
            state.token = data.token;
            state.isHost = false;
            state.isMatch = true;
            if (data.mode) state.mode = data.mode;
            state.matchCount = data.max_players;
            state.matchSuggest = (data.suggest_count && data.suggest_count !== data.max_players) ? data.suggest_count : null;
            state.mmStartTs = Date.now();
            applyServerClock(data);
            state.mmStartedAt = data.mm_started_at || Math.floor(Date.now() / 1000);
            // No "enter room" lobby — go straight to the matching-in-progress
            // screen (radar animation + live match time).
            buildMatchSeats(data.max_players);
            showScreen('view-matching');
            updateMatchTime();
            renderMmSuggest();
            startGamePolling();

            // The poll long-polls now (responses can be up to ~1.2s apart), so
            // drive the elapsed-time readout from a local ticker instead — the
            // number stays smooth while the network does the waiting.
            if (state.mmTickInterval) clearInterval(state.mmTickInterval);
            state.mmTickInterval = setInterval(() => {
                if (document.getElementById('view-matching').classList.contains('hidden')) {
                    clearInterval(state.mmTickInterval);
                    state.mmTickInterval = null;
                    return;
                }
                updateMatchTime();
            }, 500);
        }

        // Draw one seat dot per player slot around the radar's orbit ring.
        function buildMatchSeats(total) {
            const orbit = document.getElementById('mm-orbit');
            if (!orbit) return;
            orbit.innerHTML = '';
            const n = Math.max(1, total | 0);
            for (let i = 0; i < n; i++) {
                const seat = document.createElement('span');
                seat.className = 'mm-seat';
                seat.style.setProperty('--a', (i * 360 / n - 90) + 'deg');
                orbit.appendChild(seat);
            }
            const totEl = document.getElementById('mm-total');
            if (totEl) totEl.innerText = n;
            const filledEl = document.getElementById('mm-filled');
            if (filledEl) filledEl.innerText = '0';
        }

        // ---- Shared server clock ------------------------------------------
        // Every countdown is derived from the SERVER's timestamps (server_now +
        // started_at / phase_started_at / mm_started_at in the poll payload)
        // plus a one-time client/server offset — never from "when did *I* join".
        // That guarantees two players in one room always agree on the match
        // time and on which phase they are in.
        const PRE_NIGHT_SECONDS = 15;

        function applyServerClock(data) {
            if (data && typeof data.server_now === 'number' && data.server_now > 0) {
                state.serverOffset = data.server_now - Math.floor(Date.now() / 1000);
            }
        }

        function serverNow() {
            return Math.floor(Date.now() / 1000) + (state.serverOffset || 0);
        }

        // Remaining seconds of the shared pre-night chat window (0 once past).
        function preNightRemaining() {
            if (!state.gameStartedAt) return 0;
            return Math.max(0, Math.ceil(PRE_NIGHT_SECONDS - (serverNow() - state.gameStartedAt)));
        }

        // Ticking "Match Time" = how long the QUEUE has been waiting, on the
        // shared server clock (same number for everyone in the room).
        function updateMatchTime() {
            const el = document.getElementById('mm-elapsed');
            if (!el) return;
            const start = state.mmStartedAt || (state.mmStartTs ? Math.floor(state.mmStartTs / 1000) : 0);
            if (!start) return;
            const secs = Math.max(0, serverNow() - start);
            el.innerText = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
        }

        function renderMmSuggest() {
            const btn = document.getElementById('mm-suggest-btn');
            if (!btn) return;
            if (state.matchSuggest) {
                btn.classList.remove('hidden');
                btn.innerHTML = `<i data-lucide="users" size="18"></i> ${state.matchSuggest} players are waiting — switch to ${state.matchSuggest}?`;
                btn.onclick = () => confirmMatchSwitch(state.matchSuggest);
                lucide.createIcons();
            } else {
                btn.classList.add('hidden');
            }
        }

        function confirmMatchSwitch(count) {
            const btn = document.getElementById('mm-suggest-btn');
            if (btn) { btn.disabled = true; }
            const msg = `Other players are matching at ${count} players. Switch from ${state.matchCount} to ${count} players?`;
            if (!confirm(msg)) {
                if (btn) { btn.disabled = false; }
                return;
            }
            doMatchMake(count, true);
        }

        function doMatchMake(count, silent) {
            state.nickname = document.getElementById('nickname').value || 'Player';
            return fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                // Carry the character worn in the hall into the seat (guests only:
                // an account avatar wins server-side).
                body: new URLSearchParams({ action: 'matchmake', nickname: state.nickname, count: count, mode: state.mode || 'classic', avatar: (typeof myCharacter === 'function' ? myCharacter() : '') })
            }).then(res => res.json()).then(data => {
                if (data.status !== 'success') {
                    const b = document.getElementById('btn-match');
                    if (b) b.disabled = false;
                    if (!silent) alert(data.message);
                    return;
                }
                // Leaving our old match lobby before re-queueing (switch case).
                if (silent && state.roomCode) callLeaveRoom(state.roomCode, state.token);
                enterMatchLobby(data);
            }).catch(() => {
                if (!silent) alert('Network error while finding a match.');
            });
        }

        async function handleQuickMatch() {
            const btn = document.getElementById('btn-match');
            btn.disabled = true;
            const count = parseInt(document.getElementById('match-count').value, 10);
            state.nickname = document.getElementById('nickname').value || 'Player';

            const data = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                // Carry the character worn in the hall into the seat (guests only:
                // an account avatar wins server-side).
                body: new URLSearchParams({ action: 'matchmake', nickname: state.nickname, count: count, mode: state.mode || 'classic', avatar: (typeof myCharacter === 'function' ? myCharacter() : '') })
            }).then(res => res.json());

            if (data.status === 'success') {
                // No open lobby at this size, but one exists at another size:
                // ask the player whether to jump into that busy lobby instead.
                if (data.suggest_count && data.suggest_count !== count) {
                    btn.disabled = false;
                    const ans = confirm(
                        `There are no ${count}-player lobbies open right now, but a ${data.suggest_count}-player lobby is waiting.\n\nClick OK to join the ${data.suggest_count}-player lobby, or Cancel to start a fresh ${count}-player lobby.`
                    );
                    if (ans) {
                        // This request ALREADY created a lobby at the original size
                        // server-side. Abandon it before re-queueing, or it lingers
                        // as a ghost room that other players can be matched into.
                        callLeaveRoom(data.room_code, data.token);
                        await doMatchMake(data.suggest_count, true);
                    } else {
                        // Join the lobby the server just created for us.
                        enterMatchLobby(data);
                    }
                    return;
                }
                enterMatchLobby(data);
            } else {
                btn.disabled = false;
                alert(data.message);
            }
        }

        function updateMmStatus(data) {
            // Only the dedicated matching screen is driven from here.
            const textEl = document.getElementById('mm-status-text');
            if (!textEl) return;

            const isMatchLobby = data.is_match === 1 && data.room_status === 'lobby';
            if (!isMatchLobby) return;

            const players = data.players || [];
            const humans = players.filter(p => !p.is_bot).length;
            const bots = players.filter(p => p.is_bot).length;

            // Live match-time tick.
            updateMatchTime();

            // Status line.
            textEl.innerText = bots > 0
                ? 'Filling the room — starting soon...'
                : (humans > 1 ? 'Players found — waiting to fill...' : 'Searching for players...');

            // Seat fill on the radar orbit.
            const orbit = document.getElementById('mm-orbit');
            const seats = orbit ? Array.from(orbit.querySelectorAll('.mm-seat')) : [];
            seats.forEach((s, i) => {
                s.classList.toggle('filled', i < humans);
                s.classList.toggle('bot', i >= humans && i < humans + bots);
            });

            const filledEl = document.getElementById('mm-filled');
            if (filledEl) filledEl.innerText = String(humans + bots);
            const totalEl = document.getElementById('mm-total');
            if (totalEl) totalEl.innerText = String(data.max_players || state.matchCount);

            // Show WHO is in the queue, not just a seat count, so a player can
            // see the others they have actually been matched with.
            const namesEl = document.getElementById('mm-players');
            if (namesEl) {
                namesEl.innerText = players.length
                    ? 'In lobby: ' + players.map(p => p.nickname).join(', ')
                    : 'Waiting for players...';
            }
        }

        
