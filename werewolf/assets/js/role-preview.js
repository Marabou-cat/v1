/* werewolf / role-preview — menu role card
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= ROLE PREVIEW ================= */
        function updateRolePreview() {
            const count = parseInt(document.getElementById('max-players').value);
            const wolves = 1 + Math.floor((count - 4) / 3);
            const specials = count === 4 ? 0 : Math.floor((count - 3) / 2);
            const villagers = count - (wolves + specials);

            document.getElementById('create-role-info').innerHTML = `
                <strong>Squad Composition:</strong><br>
                <span class="role-tag" style="color: #ff4d4d;"><i data-lucide="skull" size="16"></i> Werewolves: ${wolves}</span>
                <span class="role-tag" style="color: var(--accent-gold);"><i data-lucide="sparkles" size="16"></i> Specials: ${specials}</span>
                <span class="role-tag" style="color: #38bdf8;"><i data-lucide="shield" size="16"></i> Villagers: ${villagers}</span>
            `;
            lucide.createIcons();
        }

        
