/* werewolf / night-ui — fade, blackout, death card
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= NIGHT/DAY TRANSITION, BLACKOUT, DEATH ================= */
        // Fade the whole screen to black and back ("Night falls" / "Dawn breaks").
        function playPhaseTransition(toStatus) {
            const el = document.getElementById('phase-fade');
            const txt = document.getElementById('phase-fade-text');
            if (!el) return;
            if (txt) txt.innerText = (toStatus === 'night') ? 'Night falls' : 'Dawn breaks';
            el.classList.add('show');
            clearTimeout(state.fadeTimer);
            state.fadeTimer = setTimeout(() => el.classList.remove('show'), 1450);
        }

        // Once your night action is locked in, black your own screen out so
        // nobody (even someone glancing over) sees the board until dawn.
        function nightBlackoutActive(d) {
            if (d.room_status !== 'night') return false;
            if (!d.is_alive) return false;
            // Doctor: keep the screen clear while the revive prompt is up.
            if (d.my_role === 'Doctor' && d.night_step === 'doctor' && !d.my_doctor_choice) return false;
            if (d.my_role === 'Werewolf') return !!d.has_voted;
            if (d.my_role === 'Seer') return !!d.my_check_target;
            if (d.my_role === 'Witch') return !!(d.my_poison_target || d.my_poison_skip || d.my_poison_used);
            return !!d.my_asleep;   // Villager, and the Doctor once bunked down
        }

        function updateNightUI(d) {
            const bo = document.getElementById('night-blackout');
            const so = document.getElementById('sleep-overlay');
            if (bo) bo.classList.toggle('show', nightBlackoutActive(d));

            // Centred Sleep button: alive villagers / doctor who haven't tapped yet.
            const doctorPromptUp = (d.my_role === 'Doctor' && d.night_step === 'doctor' && !d.my_doctor_choice);
            const needsSleep = d.room_status === 'night' && !!d.is_alive && !d.my_asleep
                && (d.my_role === 'Villager' || d.my_role === 'Doctor') && !doctorPromptUp;
            if (so) so.classList.toggle('show', !!needsSleep);
            if (needsSleep && window.lucide) lucide.createIcons();
        }

        // Show the "you died" card on the alive -> dead edge, once per game.
        function updateDeathUI(d) {
            const el = document.getElementById('death-overlay');
            if (!el || typeof d.is_alive === 'undefined') return;
            const alive = !!d.is_alive;
            if (state.lastAlive === true && alive === false && !state.deathShown) {
                state.deathShown = true;
                state.spectating = false;
                el.classList.add('show');
                if (window.lucide) lucide.createIcons();
                if (state.voice && state.voice.on) stopVoice();  // mic off for the dead
            }
            state.lastAlive = alive;
        }

        function hideGameOverlays() {
            ['phase-fade', 'night-blackout', 'sleep-overlay', 'death-overlay'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.remove('show');
            });
            clearTimeout(state.fadeTimer);
        }

        function exitGame() {
            const el = document.getElementById('death-overlay');
            if (el) el.classList.remove('show');
            leaveToMenu();
        }

        function spectateGame() {
            const el = document.getElementById('death-overlay');
            if (el) el.classList.remove('show');
            state.spectating = true;
            appendSystemMessage('You are now spectating — watch the rest of the match.');
            setPhaseLabelForSpectator();
        }

        function setPhaseLabelForSpectator() {
            const pt = document.getElementById('game-phase-text');
            if (pt) pt.innerHTML = '<i data-lucide="eye" size="18" style="vertical-align: middle;"></i> Spectating';
            if (window.lucide) lucide.createIcons();
        }

        
