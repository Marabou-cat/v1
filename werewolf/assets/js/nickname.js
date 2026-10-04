/* werewolf / nickname — persisted handle
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= NICKNAME (persisted to localStorage) ================= */
        const NICKNAME_KEY = 'werewolf.nickname';

        // Default handle: "player" followed by 5 random digits.
        function randomNickname() {
            return 'player' + Math.floor(10000 + Math.random() * 90000);
        }
        function loadSavedNickname() {
            try { return localStorage.getItem(NICKNAME_KEY) || ''; } catch (e) { return ''; }
        }
        function saveNickname(value) {
            try { localStorage.setItem(NICKNAME_KEY, value); } catch (e) {}
        }
        function initNickname() {
            const el = document.getElementById('nickname');
            if (!el) return;
            // Restore the saved handle, or mint a fresh random default.
            el.value = loadSavedNickname() || randomNickname();
            saveNickname(el.value);
            // Persist on every edit.
            el.addEventListener('input', () => saveNickname(el.value.trim()));
            el.addEventListener('change', () => saveNickname(el.value.trim()));
        }

        
