/* werewolf / voice — WebRTC mesh chat
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= VOICE CHAT (WebRTC mesh) ================= */
        // Signalling rides the existing poll (voice_signals) — no extra server.
        // One RTCPeerConnection per other player who has joined the voice room;
        // the LOWER player id is the offerer so there is never a glare.
        const VOICE_ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

        function voiceSupported() {
            return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
        }
        function voiceSignalPost(toId, kind, payload) {
            fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'voice', room_code: state.roomCode, token: state.token,
                    to_id: toId, kind: kind, payload: JSON.stringify(payload || {})
                })
            }).catch(() => {});
        }
        function voicePost(on) {
            fetch('backend.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'voice', room_code: state.roomCode, token: state.token, on: on ? 1 : 0 })
            }).catch(() => {});
        }

        async function toggleVoice() {
            if (state.voice.on) { stopVoice(); return; }
            if (!voiceSupported()) { alert('Voice chat is not supported in this browser.'); return; }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                state.voice.stream = stream;
                state.voice.on = true;
                state.voice.muted = false;
                voicePost(1);
                renderVoiceBar();
                syncVoicePeers(state.lastPlayers || []);
            } catch (e) {
                alert('Could not access the microphone (permission denied or unavailable).');
            }
        }

        function stopVoice() {
            const wasOn = state.voice.on;
            state.voice.on = false;
            if (wasOn) {
                Object.keys(state.voice.pcs).forEach(id => voiceSignalPost(id, 'bye', {}));
                voicePost(0);
            }
            Object.keys(state.voice.pcs).forEach(id => { try { state.voice.pcs[id].close(); } catch (e) {} });
            state.voice.pcs = {};
            state.voice.pendingIce = {};
            Object.keys(state.voice.audioEls).forEach(id => { try { state.voice.audioEls[id].remove(); } catch (e) {} });
            state.voice.audioEls = {};
            if (state.voice.stream) {
                state.voice.stream.getTracks().forEach(t => t.stop());
                state.voice.stream = null;
            }
            renderVoiceBar();
        }

        function voiceMuteToggle() {
            if (!state.voice.on || !state.voice.stream) return;
            state.voice.muted = !state.voice.muted;
            state.voice.stream.getAudioTracks().forEach(t => { t.enabled = !state.voice.muted; });
            renderVoiceBar();
        }

        function voiceAttachAudio(peerId, stream) {
            let el = state.voice.audioEls[peerId];
            if (!el) {
                el = document.createElement('audio');
                el.autoplay = true;
                el.setAttribute('playsinline', '');
                el.dataset.peer = peerId;
                document.body.appendChild(el);
                state.voice.audioEls[peerId] = el;
            }
            el.srcObject = stream;
            const p = el.play();
            if (p && p.catch) p.catch(() => {});
        }

        function voiceMakePeer(peerId, isInitiator) {
            const pc = new RTCPeerConnection(VOICE_ICE);
            state.voice.pcs[peerId] = pc;
            state.voice.pendingIce[peerId] = [];
            if (state.voice.stream) state.voice.stream.getTracks().forEach(t => pc.addTrack(t, state.voice.stream));
            pc.onicecandidate = (ev) => { if (ev.candidate) voiceSignalPost(peerId, 'ice', ev.candidate.toJSON()); };
            pc.ontrack = (ev) => { if (ev.streams && ev.streams[0]) voiceAttachAudio(peerId, ev.streams[0]); };
            if (isInitiator) {
                // Explicit offer (never onnegotiationneeded) so the two sides
                // can't both offer and deadlock.
                (async () => {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        voiceSignalPost(peerId, 'offer', pc.localDescription);
                    } catch (e) {}
                })();
            }
            return pc;
        }

        function voiceFlushIce(peerId) {
            const pc = state.voice.pcs[peerId];
            if (!pc) return;
            (state.voice.pendingIce[peerId] || []).forEach(c => {
                try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
            });
            state.voice.pendingIce[peerId] = [];
        }

        // Reconcile connections with the current roster (called each poll).
        function syncVoicePeers(players) {
            state.lastPlayers = players || [];
            if (!state.voice.on) { renderVoiceBar(); return; }
            players.forEach(p => {
                if (p.id === state.myId || !p.voice) return;
                if (state.voice.pcs[p.id]) return;
                voiceMakePeer(p.id, state.myId < p.id);
            });
            // Drop peers who left the voice room.
            Object.keys(state.voice.pcs).forEach(id => {
                const p = players.find(x => String(x.id) === String(id));
                if (!p || !p.voice) {
                    try { state.voice.pcs[id].close(); } catch (e) {}
                    delete state.voice.pcs[id];
                    delete state.voice.pendingIce[id];
                    if (state.voice.audioEls[id]) { try { state.voice.audioEls[id].remove(); } catch (e) {} delete state.voice.audioEls[id]; }
                }
            });
            renderVoiceBar();
        }

        async function handleVoiceSignals(signals) {
            for (const s of signals) {
                const peerId = s.from_id;
                let data = null;
                try { data = JSON.parse(s.payload); } catch (e) { data = {}; }
                try {
                    if (s.kind === 'offer') {
                        if (!state.voice.on) continue;
                        const pc = state.voice.pcs[peerId] || voiceMakePeer(peerId, false);
                        await pc.setRemoteDescription(new RTCSessionDescription(data));
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        voiceSignalPost(peerId, 'answer', pc.localDescription);
                        voiceFlushIce(peerId);
                    } else if (s.kind === 'answer') {
                        const pc = state.voice.pcs[peerId];
                        if (!pc) continue;
                        await pc.setRemoteDescription(new RTCSessionDescription(data));
                        voiceFlushIce(peerId);
                    } else if (s.kind === 'ice') {
                        const pc = state.voice.pcs[peerId];
                        if (!pc) continue;
                        if (pc.remoteDescription && pc.remoteDescription.type) {
                            try { await pc.addIceCandidate(new RTCIceCandidate(data)); } catch (e) {}
                        } else {
                            (state.voice.pendingIce[peerId] = state.voice.pendingIce[peerId] || []).push(data);
                        }
                    } else if (s.kind === 'bye') {
                        const pc = state.voice.pcs[peerId];
                        if (pc) { try { pc.close(); } catch (e) {} }
                        delete state.voice.pcs[peerId];
                    }
                } catch (e) {}
            }
        }

        function renderVoiceBar() {
            const btn = document.getElementById('voice-btn');
            const mute = document.getElementById('voice-mute-btn');
            const label = document.getElementById('voice-label');
            if (!btn) return;
            if (state.voice.on) {
                btn.classList.add('voicing');
                btn.innerHTML = '<i data-lucide="mic" size="15"></i> Leave Voice';
                if (mute) {
                    mute.style.display = 'inline-flex';
                    mute.innerHTML = `<i data-lucide="${state.voice.muted ? 'mic-off' : 'mic'}" size="15"></i> ${state.voice.muted ? 'Unmute' : 'Mute'}`;
                }
                if (label) label.innerText = state.voice.muted ? 'You are muted' : 'Live — mic on';
            } else {
                btn.classList.remove('voicing');
                btn.innerHTML = '<i data-lucide="mic-off" size="15"></i> Join Voice';
                if (mute) mute.style.display = 'none';
                if (label) label.innerText = '';
            }
            if (window.lucide) lucide.createIcons();
        }

        
