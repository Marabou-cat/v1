/* werewolf / chat-timer — pre-night countdown (server clock)
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ===== PRE-NIGHT CHAT TIMER (shared server clock) ===== */
        function startPreNightChat() {
            // The window is anchored to the SERVER's game-start timestamp, so
            // every player counts down the same 15s together. If this client
            // arrives after the window already closed, it skips straight to the
            // night phase instead of showing a phantom "chat phase".
            state.inPreNightChat = preNightRemaining() > 0;

            // Fresh match: wipe previous chat and reset player list state
            const chatMsgs = document.getElementById('chat-messages');
            chatMsgs.innerHTML = '<div class="chat-message no-anim"><span class="sender">System:</span> Welcome to Werewolf Online! Talk before night falls.</div>';
            chatMsgs.dataset.lastCount = '0';
            chatMsgs.dataset.lastSig = '';
            const gpl = document.getElementById('game-player-list');
            gpl.dataset.fullSig = '';
            gpl.dataset.rosterSig = '';
            const badge = document.getElementById('chat-timer-badge');

            if (state.chatTimerInterval) { clearInterval(state.chatTimerInterval); state.chatTimerInterval = null; }

            const tick = () => {
                const rem = preNightRemaining();
                if (badge) {
                    if (state.inPreNightChat && rem > 0) {
                        badge.style.display = 'inline-block';
                        badge.innerText = `⏱️ ${rem}s`;
                    } else {
                        badge.style.display = 'none';
                    }
                }
                if (state.inPreNightChat && rem <= 0) {
                    state.inPreNightChat = false;
                    appendSystemMessage("Chat time ended! First night begins...");
                    if (state.chatTimerInterval) { clearInterval(state.chatTimerInterval); state.chatTimerInterval = null; }
                }
            };
            tick();
            state.chatTimerInterval = setInterval(tick, 500);
        }

        
