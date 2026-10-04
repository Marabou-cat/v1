/* werewolf / nav — screen navigation
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= NAVIGATION ================= */
        /* Re-arm the menu action buttons.
           handleQuickMatch() disables #btn-match for the duration of the request
           and, on its SUCCESS path, navigates to the matching screen leaving the
           button disabled. Nothing ever re-enabled it, so exiting matchmaking or
           finishing/leaving a game handed the player a permanently dead
           "Find Match" button — the "can't match again" bug.
           Every route back to the menu funnels through showScreen(), so the
           buttons are re-armed there and no caller has to remember. */
        function resetMenuButtons() {
            // #btn-match is the only one that leaks today (handleQuickMatch
            // disables it). Keep the list so future buttons are covered.
            ['btn-match'].forEach(function (id) {
                const b = document.getElementById(id);
                if (b) b.disabled = false;
            });
        }

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
            // Re-arm the pre-game action buttons on EVERY entry to these screens.
            // #btn-match lives on the size picker (view-match), NOT the main menu,
            // so re-arming only on view-menu was not enough: coming back to the
            // picker still showed a dead "Find Match" button.
            if (screenId === 'view-menu' || screenId === 'view-match' ||
                screenId === 'view-create' || screenId === 'view-join') {
                resetMenuButtons();
                // Size labels carry the REAL composition for the chosen mode.
                if (typeof refreshSizeOptions === 'function') refreshSizeOptions();
            }
            if (typeof placeAuthBar === 'function') placeAuthBar(screenId);
            if (typeof updateBgmForScreen === 'function') updateBgmForScreen(screenId, state.roomStatus);
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
            if (typeof hideVitals === 'function') hideVitals();
            // The settlement card is hidden, not removed (it carries the sig that
            // stops a duplicate replay), so it must be dismissed explicitly here —
            // otherwise EXIT leaves it sitting over the menu.
            if (typeof hideVictory === 'function') hideVictory();
            if (typeof clearClaw === 'function') clearClaw();
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

        
