/* werewolf / state — shared client state
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

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
            chatTimerInterval: null,
            chatTimeRemaining: 15,
            inPreNightChat: false,
            lastEvent: '',
            lastPhase: '',
            myId: 0,
            voice: { on: false, muted: false, stream: null, pcs: {}, pendingIce: {}, audioEls: {} },
            lastRoomStatus: '',
            lastAlive: null,
            deathShown: false,
            spectating: false,
            fadeTimer: null
        };

        
