/* werewolf / render — roster & card helpers
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= RENDER HELPERS ================= */
        function playerCardHtml(p, data, extra, index, noAnim) {
            const isMe = (p.id === data.my_id);
            const statusIcon = p.is_alive
                ? '<i data-lucide="shield" size="20" style="color: #38bdf8; flex: none;"></i>'
                : '<i data-lucide="skull" size="20" style="color: var(--accent-red); flex: none;"></i>';
            const bloodPile = p.is_alive ? '' : '<div class="blood-pile"></div>';
            const youTag = isMe ? '<span class="you-tag">YOU</span>' : '';
            // Day voting: show the running vote count on every card, and flag
            // the player YOU voted for.
            const voting = (data.room_status === 'day');
            const iVotedThis = voting && (data.my_vote_id === p.id);
            const voteBadge = (voting && p.votes > 0)
                ? `<span class="vote-badge"><i data-lucide="vote" size="14"></i> ${p.votes}</span>` : '';
            const myVoteTag = iVotedThis ? '<span class="my-vote-tag">YOUR VOTE</span>' : '';
            // Role chip: the backend reveals it for your own seat AND for any
            // dead player (dead roles are public and stay visible); alive
            // opponents show 'Hidden' until the final reveal.
            const revealedRole = (p.role && p.role !== 'Hidden' && p.role !== 'unassigned') ? p.role : null;
            const roleChip = revealedRole
                ? `<span class="role-chip" style="color:${roleChipColor(revealedRole)};">${revealedRole}</span>` : '';
            const cls = `player-item ${p.is_alive ? '' : 'dead'} ${isMe ? 'me' : ''} ${iVotedThis ? 'voted-by-me' : ''} ${noAnim ? 'no-anim' : ''}`;
            return `
                <li class="${cls}" style="animation-delay: ${(index * 60) % 500}ms;">
                    <span class="player-info-wrap">${statusIcon} <span class="pname">${esc(p.nickname)}</span> ${youTag} ${roleChip} ${myVoteTag} ${voteBadge} ${bloodPile}</span>
                    ${extra}
                </li>
            `;
        }

        // Renders a roster list idempotently.
        //  - fullSig:   everything that changes the markup (roster + buttons).
        //                If unchanged -> skip entirely (no DOM write).
        //  - rosterSig: only who is in the room (ids/names/alive/roles).
        //                If unchanged -> static re-render with no-anim so
        //                button states flip without replaying the entrance
        //                stagger on every 1.5s poll.
        function renderRosterList(listEl, data, buildExtra, mode) {
            const rosterSig = data.players.map(p => [p.id, p.nickname, p.is_alive, p.role, p.votes]).join('|');
            // mode matters: the same roster renders different markup per phase
            // (e.g. pre-night has no action buttons, night does)
            const fullSig = mode + '|' + rosterSig + '#' + [data.my_role, data.is_alive, data.has_voted, data.my_target_id, data.my_vote_id].join('|');
            if (listEl.dataset.fullSig === fullSig) return;
            const rosterChanged = listEl.dataset.rosterSig !== rosterSig;
            listEl.dataset.fullSig = fullSig;
            listEl.dataset.rosterSig = rosterSig;
            listEl.innerHTML = data.players.map((p, i) =>
                playerCardHtml(p, data, buildExtra ? buildExtra(p) : '', i, !rosterChanged)
            ).join('');
            lucide.createIcons();
        }

        function flashEventBanner() {
            const banner = document.getElementById('event-banner');
            banner.classList.remove('flash');
            void banner.offsetWidth;
            banner.classList.add('flash');
        }

        function setRoleIcon(role) {
            const icons = {
                'Werewolf': 'paw-print',
                'Villager': 'shield',
                'Seer': 'eye',
                'Doctor': 'cross',
                'Witch': 'flask-conical',
                'Hunter': 'crosshair',
                'Cupid': 'heart'
            };
            return `<i data-lucide="${icons[role] || 'user'}" size="26"></i>`;
        }

        // Colour for a revealed role chip: wolves red, special roles blue,
        // plain villagers gold.
        function roleChipColor(role) {
            if (role === 'Werewolf') return '#ff4d4d';
            if (['Seer', 'Doctor', 'Witch', 'Hunter', 'Cupid'].includes(role)) return '#38bdf8';
            return 'var(--accent-gold)';
        }

        
