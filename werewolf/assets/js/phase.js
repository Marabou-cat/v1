/* werewolf / phase — body phase theming
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= PHASE THEMING ================= */
        function setPhase(phase) {
            if (state.lastPhase === phase) return;
            state.lastPhase = phase;
            document.body.dataset.phase = phase;
            const flash = document.getElementById('phase-flash');
            if (phase === 'night') {
                flash.className = 'phase-flash';
                void flash.offsetWidth; // restart animation
                flash.classList.add('night');
            } else if (phase === 'day') {
                flash.className = 'phase-flash';
                void flash.offsetWidth;
                flash.classList.add('day');
            }
        }

        
