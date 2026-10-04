/* ================= STATE ================= */
        // Escape untrusted text before it goes into innerHTML. Guest-chosen
        // nicknames are free text and get rendered into EVERY other player's
        // roster + chat, so this is the difference between a nickname and a
        // stored-XSS payload. (Chat bodies are already escaped server-side.)
        function esc(s) {
            return String(s === null || s === undefined ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        let state = {
            roomCode: '',
            token: '',
            nickname: '',
            isHost: false,
            isMatch: false,
            matchCount: 6,
            matchSuggest: null,
            matchTransitioning: false,
            mmStartTs: null,
            mmStartedAt: 0,
            gameStartedAt: 0,
            serverOffset: 0,
            pollInterval: null,
            pollSig: '',
            pollRunning: false,
            mmTickInterval: null,
            chatTimerInterval: null,
            chatTimeRemaining: 15,
            inPreNightChat: false,
            lastEvent: '',
            lastPhase: '',
            myId: 0,
            authUser: null,
            authSig: '',
            voice: { on: false, muted: false, stream: null, pcs: {}, pendingIce: {}, audioEls: {} },
            lastRoomStatus: '',
            lastAlive: null,
            deathShown: false,
            spectating: false,
            fadeTimer: null,
            voteCutsceneTimer: null
        };

        
