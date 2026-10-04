/* werewolf / nav — screen navigation
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= NAVIGATION ================= */
        function showScreen(screenId) {
            ['view-menu', 'view-create', 'view-join', 'view-match', 'view-matching', 'view-lobby', 'view-game'].forEach(id => {
                document.getElementById(id).classList.add('hidden');
            });
            const target = document.getElementById(screenId);
            target.classList.add('hidden'); // reset animation
            target.classList.remove('hidden');
            target.style.animation = 'none';
            void target.offsetWidth;
            target.style.animation = '';
            if (screenId === 'view-menu' || screenId === 'view-create' || screenId === 'view-join' || screenId === 'view-match') {
                setPhase('menu');
            }
            if (screenId === 'view-lobby') setPhase('lobby');
            if (screenId === 'view-create') updateRolePreview();
            if (screenId === 'view-match') updateMatchRolePreview();
            lucide.createIcons();
        }

        /* Best-effort leave request. Fire-and-forget: never blocks the UI and
           never throws. keepalive:true lets the request survive a tab close. */
        function callLeaveRoom(roomCode, token) {
            if (!roomCode || !token) return;
            try {
                fetch('backend.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ action: 'leave_room', room_code: roomCode, token: token }),
                    keepalive: true
                }).catch(() => {});
            } catch (e) { /* best effort */ }
        }

        function leaveToMenu() {
            const rc = state.roomCode;
            const tk = state.token;
            const inGame = state.lastPhase && state.lastPhase !== 'lobby';
            if (inGame && !confirm('Leave the match? Your seat will be abandoned.')) {
                return;
            }
            // Tell the server to remove us BEFORE we wipe local state, so we
            // never leave a ghost seat behind that would duplicate us on rejoin.
            callLeaveRoom(rc, tk);

            if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
            state.pollRunning = false;   // stops the self-scheduling long-poll loop
            state.pollSig = '';
            if (state.mmTickInterval) { clearInterval(state.mmTickInterval); state.mmTickInterval = null; }
            if (state.chatTimerInterval) { clearInterval(state.chatTimerInterval); state.chatTimerInterval = null; }
            if (typeof stopVoice === 'function') stopVoice();
            if (typeof hideGameOverlays === 'function') hideGameOverlays();
            state.lastRoomStatus = '';
            state.lastAlive = null;
            state.deathShown = false;
            state.spectating = false;
            state.roomCode = '';
            state.token = '';
            state.isHost = false;
            state.isMatch = false;
            state.matchTransitioning = false;
            state.mmStartTs = null;
            state.mmStartedAt = 0;
            state.gameStartedAt = 0;
            state.matchSuggest = null;
            state.inPreNightChat = false;
            state.lastEvent = '';
            state.lastPhase = '';
            document.getElementById('game-event-log').innerText = 'Discuss before the first night falls...';
            const mmSuggest = document.getElementById('mm-suggest-btn');
            if (mmSuggest) mmSuggest.classList.add('hidden');
            showScreen('view-menu');
        }

        // If the tab is closed/refreshed while we're still in a room, drop our
        // seat too (covers the "crashed before leaving" case).
        window.addEventListener('beforeunload', () => {
            callLeaveRoom(state.roomCode, state.token);
        });

        
