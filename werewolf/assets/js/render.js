/* werewolf / render — roster & card helpers
   split out of the old monolithic index.html — classic script, shares
   the page global scope (order matters; see index.html script tags). */

/* ================= RENDER HELPERS ================= */
        function playerCardHtml(p, data, extra, index, noAnim) {
            const isMe = (p.id === data.my_id);
            const statusIcon = p.is_alive
                ? '<i data-lucide="shield" size="20" style="color: #38bdf8; flex: none;"></i>'
                : '<span class="status-dead-ico" title="eliminated" aria-label="eliminated"></span>';
            const bloodPile = p.is_alive ? '' : '<div class="blood-pile"></div>';
            const youTag = isMe ? '<span class="you-tag">YOU</span>' : '';
            // Account-bound face. Denormalised onto the seat server-side, so it
            // costs the poll nothing extra.
            const avatar = avatarHtml(p.avatar, 30);
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
            // Chaos Night: a werewolf is sent every player's HP (the server only
            // includes it for that seat — it is null for everyone else). Show a
            // compact bar + number when it is present. `is_wolf` marks the pack.
            // Gated on the MODE too: a classic board has no health bars at all, so
            // even a stray value must not draw one. And once the match is OVER the
            // board stops drawing bars entirely — the settlement card is where the
            // final numbers are revealed, so a bar must never linger on a finished
            // table (that was the "HP bar at the end of the match" report).
            let hpBar = '';
            if (data && data.mode === 'chaos' && data.room_status !== 'ended'
                && p.hp !== null && p.hp !== undefined) {
                const mx = p.max_hp || 100;
                const pct = Math.max(0, Math.min(100, Math.round(p.hp * 100 / mx)));
                const lvl = pct <= 34 ? ' low' : (pct <= 67 ? ' mid' : '');
                hpBar = `<span class="p-hp"><span class="p-hp-track"><span class="p-hp-fill${lvl}" style="width:${pct}%"></span></span><span class="p-hp-num">${p.hp}</span></span>`;
            }
            const packTag = p.is_wolf ? '<span class="pack-tag">PACK</span>' : '';
            // Chaos Night: distrust is PUBLIC — every seat reads every meter, and
            // hitting 100% is what drives a player out of the village.
            let distrustChip = '';
            if (p.distrust !== null && p.distrust !== undefined) {
                const d = Math.round(p.distrust);
                const dc = d >= 67 ? ' hot' : (d >= 34 ? ' warn' : '');
                distrustChip = `<span class="distrust-chip${dc}" title="Public distrust — at 100% they are driven out">⚖ ${d}%</span>`;
            }
            return `
                <li class="${cls}" style="animation-delay: ${(index * 60) % 500}ms;">
                    <span class="player-info-wrap">${avatar} ${statusIcon} <span class="pname">${esc(p.nickname)}</span> ${youTag} ${packTag} ${roleChip} ${myVoteTag} ${voteBadge} ${distrustChip} ${hpBar} ${bloodPile}</span>
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
            // nickname -> avatar, so a chat bubble can show the speaker's face.
            state.rosterAvatars = {};
            (data.players || []).forEach(function (p) { if (p.nickname) state.rosterAvatars[p.nickname] = p.avatar; });

            const rosterSig = data.players.map(p => [p.id, p.nickname, p.avatar, p.is_alive, p.role, p.votes]).join('|');
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

        
