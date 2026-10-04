/* werewolf / room — create/join/leave actions
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= ROOM ACTIONS ================= */
        async function handleCreateRoom() {
            state.nickname = document.getElementById('nickname').value || 'Host';
            const maxPlayers = document.getElementById('max-players').value;

            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'create_room', nickname: state.nickname, max_players: maxPlayers })
            });

            const data = await res.json();
            if (data.status === 'success') {
                state.roomCode = data.room_code;
                state.token = data.token;
                state.isHost = true;
                triggerCutscene(data.cutscene, () => {
                    showScreen('view-lobby');
                    startGamePolling();
                });
            } else {
                alert(data.message);
            }
        }

        async function handleJoinRoom() {
            state.nickname = document.getElementById('nickname').value || 'Villager';
            const code = document.getElementById('join-code').value.trim();

            if (code.length !== 5) {
                alert("Please enter a valid 5-character room code.");
                return;
            }

            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'join_room', nickname: state.nickname, room_code: code })
            });

            const data = await res.json();
            if (data.status === 'success') {
                state.roomCode = data.room_code;
                state.token = data.token;
                state.isHost = false;
                triggerCutscene(data.cutscene, () => {
                    showScreen('view-lobby');
                    startGamePolling();
                });
            } else {
                alert(data.message);
            }
        }

        async function handleStartGame() {
            const btn = document.getElementById('btn-start-game');
            btn.disabled = true;
            const res = await fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'start_game', room_code: state.roomCode, token: state.token })
            });

            const data = await res.json();
            if (data.status === 'success') {
                applyServerClock(data);
                if (data.started_at) state.gameStartedAt = data.started_at;
                triggerCutscene(data.cutscene, () => {
                    startPreNightChat();
                });
            } else {
                alert(data.message);
                btn.disabled = false;
            }
        }

        
