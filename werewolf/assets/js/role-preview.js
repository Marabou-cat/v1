/* werewolf / role-preview — menu role card
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= ROLE PREVIEW ================= */
        function updateRolePreview() {
            const count = parseInt(document.getElementById('max-players').value);
            const b = roleBreakdown(count, state.mode || 'classic');

            document.getElementById('create-role-info').innerHTML = `
                <strong>${esc(modeLabel(state.mode || 'classic'))} &middot; Squad Composition:</strong><br>
                <span class="role-tag" style="color: #ff4d4d;"><i data-lucide="skull" size="16"></i> Werewolves: ${b.wolves}</span>
                <span class="role-tag" style="color: var(--accent-gold);"><i data-lucide="sparkles" size="16"></i> Specials: ${b.specials}</span>
                <span class="role-tag" style="color: #38bdf8;"><i data-lucide="shield" size="16"></i> Villagers: ${b.villagers}</span>
            `;
            lucide.createIcons();
        }

        
