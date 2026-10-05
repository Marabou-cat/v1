<?php
/* werewolf / lib/actions-play.php - action handlers: send_message, poll_game, night_action, doctor_action, day_vote
   Each was formerly a `case` body in backend.php's switch; each
   receives $pdo and echoes its own JSON response. */

function handleSendMessage(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $messageText = trim($_POST['message'] ?? '');

        if ($messageText === '') {
            echo json_encode(["status" => "error", "message" => "Message cannot be empty."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me) {
            echo json_encode(["status" => "error", "message" => "Unauthorized sender."]);
            exit;
        }

        $stmt = $pdo->prepare("INSERT INTO messages (room_code, sender_name, message) VALUES (?, ?, ?)");
        $stmt->execute([$roomCode, $me['nickname'], htmlspecialchars($messageText)]);

        echo json_encode(["status" => "success", "message" => "Message sent."]);
}
function handlePollGame(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room) {
            echo json_encode(["status" => "error", "message" => "Room collapsed."]);
            exit;
        }

        // Signed-in user for this request (null for guests). Accounts are
        // optional — everything below works exactly the same without one.
        $authUser = authUser($pdo);

        // --- Long-poll -------------------------------------------------------
        // Hold this request until something the CLIENT can see actually changes
        // (or the wait budget expires) BEFORE doing any work.  The client then
        // re-requests immediately, so the request RATE stays low while perceived
        // latency becomes the change-detection granularity.
        //
        // The tick is 25ms: wolfStateSig() is a single ~0.3ms aggregate, so a
        // tight loop is still nearly free on a small server, and worst-case
        // detection is ~25ms + RTT instead of the old 200ms + RTT.
        // Clients that omit wait/sig keep the old immediate-response behaviour.
        $waitMs = (int)($_POST['wait'] ?? 0);
        $sigIn  = (string)($_POST['sig'] ?? '');
        if ($waitMs > 0 && $sigIn !== '') {
            $deadline = microtime(true) + min($waitMs, 15000) / 1000.0;
            while (microtime(true) < $deadline) {
                try {
                    if (wolfStateSig($pdo, $roomCode) !== $sigIn) break;  // changed -> respond now
                } catch (Exception $e) {
                    break;
                }
                usleep(25000);   // 25 ms
            }
        }

        // Heartbeat: mark this room (and player) live so the reaper never
        // mistakes an active lobby/game for an abandoned one, then sweep any
        // stale rooms on a short throttle.
        touchPresence($pdo, $roomCode, $token);
        maybeReap($pdo);

        // Matchmaker: once the 30s window is up, top up with bots...
        fillBotsIfNeeded($pdo, $room);
        // ...and auto-start the moment the room is full.
        if (!empty($room['is_match']) && $room['status'] === 'lobby') {
            $stmt = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
            $stmt->execute([$roomCode]);
            if ((int)$stmt->fetch()['c'] >= (int)$room['max_players']) {
                beginGame($pdo, $roomCode);
                // Re-read the room: beginGame may have been a no-op because a
                // concurrent poll already started the game (atomic claim). The
                // stale in-memory copy must never be used for win checks.
                $ri = $pdo->prepare("SELECT status, last_event FROM rooms WHERE room_code = ?");
                $ri->execute([$roomCode]);
                $fresh = $ri->fetch();
                $room['status'] = $fresh['status'];
                if ($fresh['last_event'] !== null) $room['last_event'] = $fresh['last_event'];
            }
        }

        // Drive the AI so a match never stalls waiting on a bot, then let the
        // phase resolve as soon as every actor has acted (this also covers the
        // "everyone who can act is a bot" case, which no client call would
        // otherwise ever trigger).
        if ($room['status'] === 'night') {
            if (advanceNight($pdo, $roomCode)) $room['status'] = 'day';
        } elseif ($room['status'] === 'day') {
            processDayBots($pdo, $roomCode);
            if (resolveDay($pdo, $roomCode)) $room['status'] = 'night';
        }

        // Refresh the room's phase clocks after any phase change so the client
        // always receives the authoritative server timestamps for the CURRENT
        // phase (status/last_event/started_at/phase_started_at + night step).
        $ri2 = $pdo->prepare("SELECT status, last_event, started_at, phase_started_at, night_step, pending_victim, night_deadline FROM rooms WHERE room_code = ?");
        $ri2->execute([$roomCode]);
        $fresh2 = $ri2->fetch();
        if ($fresh2) {
            $room['status'] = $fresh2['status'];
            if ($fresh2['last_event'] !== null) $room['last_event'] = $fresh2['last_event'];
            $room['started_at'] = (int)$fresh2['started_at'];
            $room['phase_started_at'] = (int)$fresh2['phase_started_at'];
            $room['night_step'] = $fresh2['night_step'];
            $room['pending_victim'] = $fresh2['pending_victim'];
            $room['night_deadline'] = (int)$fresh2['night_deadline'];
        }

        // Players are read AFTER deal/phase resolution so the win check below
        // never runs on the stale pre-deal snapshot (all "unassigned" roles) —
        // that race could falsely mark a fresh game as 'ended'.
        $stmt = $pdo->prepare("SELECT id, nickname, avatar, session_token, role, is_alive, target_id, vote_id, vote_skip, is_bot, bot_ready_at, bot_last_chat, check_target, seer_target, seer_result, poison_target, poison_skip, poison_used, revive_used, doctor_choice, asleep, voice_on, user_id, rating_delta, user_won, xp_delta, wolf_votes, special_kills, damage_done, hp, max_hp, hp_delta, heal_target, seer_hp, distrust FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();

        // Let a bot occasionally drop a chat line while the game is live.
        if ($room['status'] === 'night' || $room['status'] === 'day') {
            botChat($pdo, $roomCode, $players);
        }

        // Fetch room messages (runs after botChat so a fresh bot line can be
        // included in this same poll).
        $stmtMsg = $pdo->prepare("SELECT sender_name, message, created_at FROM messages WHERE room_code = ? ORDER BY id ASC LIMIT 50");
        $stmtMsg->execute([$roomCode]);
        $messages = $stmtMsg->fetchAll();

        $isChaos = (validMode($room['mode'] ?? '') === MODE_CHAOS);
        $myRole = 'unassigned';
        $myId = null;
        $isAlive = 1;
        $myTargetId = null;
        $myVoteId = null;
        $myVoteSkip = 0;
        $myUserId = null;
        $myRatingDelta = null;
        $myUserWon = null;
        $myXpDelta = null;
        $hasVoted = false;
        $myCheckTarget = null;
        $mySeerTarget = null;
        $mySeerResult = null;
        $myPoisonTarget = null;
        $myPoisonUsed = 0;
        $myPoisonSkip = 0;
        $myReviveUsed = 0;
        $myDoctorChoice = null;
        $myAsleep = 0;
        // Chaos Night (all NULL/absent in classic, which is how the client knows
        // to hide every HP affordance).
        $myHp = null;
        $myMaxHp = null;
        $myHpDelta = null;
        $myHealTarget = null;
        $mySeerHp = null;

        foreach ($players as $p) {
            if ($p['session_token'] === $token) {
                $myRole = $p['role'];
                $myId = $p['id'];
                $isAlive = (int)$p['is_alive'];
                $myTargetId = $p['target_id'];
                $myVoteId = $p['vote_id'];
                $myCheckTarget = $p['check_target'];
                $mySeerTarget = $p['seer_target'];
                $mySeerResult = $p['seer_result'];
                $myPoisonTarget = $p['poison_target'];
                $myPoisonUsed = (int)$p['poison_used'];
                $myPoisonSkip = (int)$p['poison_skip'];
                $myReviveUsed = (int)$p['revive_used'];
                $myDoctorChoice = $p['doctor_choice'];
                $myAsleep = (int)$p['asleep'];
                $myVoteSkip = (int)$p['vote_skip'];
                // HP is a chaos-only quantity: gate these on the MODE, not merely on
                // the value being non-null, so a classic seat can never ship one.
                $myHp = ($isChaos && $p['hp'] !== null) ? (int)$p['hp'] : null;
                $myMaxHp = ($isChaos && $p['max_hp'] !== null) ? (int)$p['max_hp'] : null;
                $myHpDelta = ($isChaos && $p['hp_delta'] !== null) ? (int)$p['hp_delta'] : null;
                $myHealTarget = ($p['heal_target'] !== null) ? (int)$p['heal_target'] : null;
                $mySeerHp = ($p['seer_hp'] !== null) ? (int)$p['seer_hp'] : null;
                $myUserId = $p['user_id'] !== null ? (int)$p['user_id'] : null;
                $myRatingDelta = ($p['rating_delta'] !== null) ? (int)$p['rating_delta'] : null;
                $myUserWon = ($p['user_won'] !== null) ? (int)$p['user_won'] : null;
                $myXpDelta = ($p['xp_delta'] !== null) ? (int)$p['xp_delta'] : null;

                // Signed in but still sitting in a guest seat (joined before
                // logging in): attach the account once so this match counts.
                if ($authUser && $myUserId === null) {
                    try {
                        $pdo->prepare("UPDATE players SET user_id = ? WHERE id = ?")
                            ->execute([(int)$authUser['id'], (int)$p['id']]);
                        $myUserId = (int)$authUser['id'];
                    } catch (Exception $e) {}
                }

                if ($room['status'] === 'night' && $p['role'] === 'Werewolf') {
                    $hasVoted = ($p['target_id'] !== null);
                } elseif ($room['status'] === 'day') {
                    $hasVoted = ($p['vote_id'] !== null || (int)$p['vote_skip']);
                }
                break;
            }
        }

        // Defence in depth: a Chaos seat must always have an HP pool. If one ever
        // ends up without (e.g. a bot that inherited a mid-game seat before the
        // leave-handler was fixed), fall back to full so the player's own vitals
        // still render. Read-only: the hot path never writes.
        if (validMode($room['mode'] ?? '') === MODE_CHAOS && $myHp === null) {
            $myHp = CHAOS_HP;
            $myMaxHp = CHAOS_HP;
        }

        // Chaos Night: a WEREWOLF reads every player's vitals and can pick out the
        // rest of the pack. Everyone else still sees nothing but their own numbers.
        $wolfVision = (validMode($room['mode'] ?? '') === MODE_CHAOS
                       && $myRole === 'Werewolf'
                       && in_array($room['status'], ['night', 'day'], true));

        // Being bitten is FELT immediately: while the night is running, tell the
        // victim a claw is on them, so the sting lands before dawn announces the
        // body. Sums every wolf whose bite is pointed at this seat.
        //
        // CHAOS ONLY. Classic has no HP pools — a claw there is meaningless AND a
        // spoiler (the victim is not supposed to know the wolves picked them, and
        // the Doctor may still save them). Without this gate a classic player who
        // merely got targeted saw claw marks, red smoke and a bite readout out of
        // nowhere seconds into the night, since bot wolves pick within 2-8s.
        $incomingDamage = 0;
        if ($room['status'] === 'night' && $isAlive && (int)$myId > 0
            && validMode($room['mode'] ?? '') === MODE_CHAOS) {
            foreach ($players as $p) {
                if ($p['role'] === 'Werewolf' && (int)$p['is_alive'] === 1
                    && (int)($p['target_id'] ?? 0) === (int)$myId) {
                    $incomingDamage += CHAOS_BITE;
                }
            }
        }

        // Skill info for THIS player only (never leaked to other seats).
        $mySeerTargetName = null;
        if ($mySeerTarget) {
            foreach ($players as $p) { if ((int)$p['id'] === (int)$mySeerTarget) { $mySeerTargetName = $p['nickname']; break; } }
        }
        // The Doctor only learns tonight's victim while the night is waiting on
        // their revive decision.
        $doctorVictimName = null;
        if ($myRole === 'Doctor' && $isAlive && validMode($room['mode'] ?? '') !== MODE_CHAOS
            && ($room['night_step'] ?? '') === 'doctor' && (int)($room['pending_victim'] ?? 0) > 0) {
            foreach ($players as $p) { if ((int)$p['id'] === (int)$room['pending_victim']) { $doctorVictimName = $p['nickname']; break; } }
        }

        // Voice signalling: hand this client any WebRTC messages addressed to
        // it, then mark them delivered (the poll IS the signalling channel).
        $voiceSignals = [];
        if ($myId) {
            $vs = $pdo->prepare("SELECT id, from_id, kind, payload FROM voice_signals WHERE to_id = ? AND delivered = 0 ORDER BY id ASC LIMIT 60");
            $vs->execute([$myId]);
            $voiceSignals = $vs->fetchAll();
            if (count($voiceSignals) > 0) {
                $ids = array_column($voiceSignals, 'id');
                $in = implode(',', array_fill(0, count($ids), '?'));
                $pdo->prepare("UPDATE voice_signals SET delivered = 1 WHERE id IN ($in)")->execute($ids);
            }
            // Housekeeping: drop stale signals (delivered or not) after 2 min.
            $pdo->prepare("DELETE FROM voice_signals WHERE room_code = ? AND created_at < (NOW() - INTERVAL 2 MINUTE)")->execute([$roomCode]);
        }

        if ($room['status'] !== 'lobby' && $room['status'] !== 'ended') {
            $aliveWerewolves = 0;
            $aliveVillagersOrSpecials = 0;
            foreach ($players as $p) {
                if ($p['is_alive'] == 1) {
                    if ($p['role'] === 'Werewolf') {
                        $aliveWerewolves++;
                    } else {
                        $aliveVillagersOrSpecials++;
                    }
                }
            }

            if ($aliveWerewolves === 0) {
                $stmt = $pdo->prepare("UPDATE rooms SET status = 'ended', winner = 'villagers', last_event = 'Villagers win! All werewolves have been eliminated.' WHERE room_code = ?");
                $stmt->execute([$roomCode]);
                // rowCount() > 0 means THIS request flipped the room, so the
                // one-time stats award happens exactly once even if two polls
                // compute the win simultaneously.
                if ($stmt->rowCount() > 0) authAwardGame($pdo, $roomCode, 'villagers');
                $room['status'] = 'ended';
                $room['last_event'] = 'Villagers win! All werewolves have been eliminated.';
            } elseif ($aliveWerewolves >= $aliveVillagersOrSpecials) {
                $stmt = $pdo->prepare("UPDATE rooms SET status = 'ended', winner = 'werewolves', last_event = 'Werewolves win! They have outnumbered the villagers.' WHERE room_code = ?");
                $stmt->execute([$roomCode]);
                if ($stmt->rowCount() > 0) authAwardGame($pdo, $roomCode, 'werewolves');
                $room['status'] = 'ended';
                $room['last_event'] = 'Werewolves win! They have outnumbered the villagers.';
            }

            // A finished table must not keep pending day-vote marks. The client
            // renders "Voted"/"YOUR VOTE" straight from my_vote_id, but the tally is
            // only computed while the room is in the day phase — so a leftover mark
            // showed up as a vote that was never counted anywhere.
            if ($room['status'] === 'ended') {
                $pdo->prepare("UPDATE players SET vote_id = NULL, vote_skip = 0 WHERE room_code = ?")->execute([$roomCode]);
                foreach ($players as $i => $pp) {
                    $players[$i]['vote_id'] = null;
                    $players[$i]['vote_skip'] = 0;
                }
                // The per-viewer scalars were captured from the snapshot read
                // BEFORE this point, so they must be reset too — otherwise the
                // payload still carried my_vote_id and the client drew a vote mark
                // for a vote that no longer exists anywhere.
                $myVoteId = null;
                $myVoteSkip = 0;
                $hasVoted = false;
            }
        }

        // Live vote tally — only counted (and only revealed) during the day, so the
        // roster can show each player's running vote count. This must apply the SAME
        // rule as dayVoteTally()/resolveDay(): a dead seat's leftover vote_id is not a
        // vote, and neither is a vote aimed at a seat that is no longer alive. Counting
        // those (as this block used to) made the cards show counts that did not add up
        // to the lynch, and often made several seats look level when they were not.
        $voteTally = [];
        if ($room['status'] === 'day') {
            $livingIds = [];
            foreach ($players as $p) {
                if ((int)$p['is_alive'] === 1) $livingIds[(int)$p['id']] = true;
            }
            foreach ($players as $p) {
                if ((int)$p['is_alive'] !== 1) continue;          // dead seats do not vote
                if ((int)$p['vote_skip']) continue;               // abstentions are separate
                $tid = (int)$p['vote_id'];
                if ($tid <= 0 || !isset($livingIds[$tid])) continue;   // vote at a corpse
                $voteTally[$tid] = ($voteTally[$tid] ?? 0) + 1;
            }
        }

        // Role visibility: your own card is always real. Others' roles are
        // only revealed at the END (final reveal); during night/day they are
        // masked so no client can read the table from the poll payload.
        $playerData = array_map(function($p) use ($room, $myId, $voteTally) {
            $role = $p['role'];
            $isAlive = (int)$p['is_alive'];
            // Reveal rule: your own card is always real; a DEAD player's role is
            // public the moment they die (and stays shown); everyone else stays
            // masked until the final reveal at 'ended'.
            $reveal = ($p['id'] === $myId)
                || ($isAlive === 0)
                || in_array($room['status'], ['lobby', 'ended'], true)
                || $role === 'unassigned';
            if (!$reveal) $role = 'Hidden';
            return [
                "id" => $p['id'],
                "nickname" => $p['nickname'],
                "avatar" => $p['avatar'] ?: 'paw',
                "is_alive" => $isAlive,
                // HP is HIDDEN during play — EXCEPT from a werewolf, who was given
                // full vision of the table (and of the pack). It is also public once
                // the match is over. Never send anyone else's HP to a non-wolf seat:
                // the response is readable by whoever holds that browser.
                // HP is a CHAOS concept. Gate it on the MODE, not merely on the value
                // being non-null: a classic seat must never render a health bar even
                // if a stray value ever lands in the column (e.g. a seat inherited
                // from a chaos predecessor). Revealed to everyone only once ended.
                "hp" => ((validMode($room['mode'] ?? '') === MODE_CHAOS) && ($room['status'] === 'ended' || $wolfVision) && $p['hp'] !== null) ? (int)$p['hp'] : null,
                "max_hp" => ((validMode($room['mode'] ?? '') === MODE_CHAOS) && ($room['status'] === 'ended' || $wolfVision) && $p['max_hp'] !== null) ? (int)$p['max_hp'] : null,
                "is_wolf" => ($wolfVision && $p['role'] === 'Werewolf') ? 1 : 0,
                // Distrust is PUBLIC (unlike HP) — every seat may read every meter.
                "distrust" => (validMode($room['mode'] ?? '') === MODE_CHAOS && $p['distrust'] !== null)
                    ? round((float)$p['distrust'], 1) : null,
                "role" => $role,
                "is_bot" => (int)($p['is_bot'] ?? 0),
                "votes" => (int)($voteTally[(int)$p['id']] ?? 0),
                "voice" => (int)($p['voice_on'] ?? 0)
            ];
        }, $players);

        $roleBreakdown = calculateRoles(count($players));

        $mmRemaining = 0;
        if (!empty($room['is_match']) && $room['status'] === 'lobby') {
            $mmRemaining = max(0, (int)$room['mm_deadline'] - time());
        }

        // Shared clocks. Every client derives the match timer and the
        // pre-night chat countdown from these SERVER timestamps (never a local
        // "when did *I* join" timestamp), so two players in the same room can
        // never show different elapsed times or different phases.
        $serverNow = time();
        $mmStartedAt = 0;
        if (!empty($room['is_match']) && $room['status'] === 'lobby' && !empty($room['mm_deadline'])) {
            $mmStartedAt = max(0, (int)$room['mm_deadline'] - MATCH_WAIT_SECONDS);
        }

        // --- Settlement awards (final frame only) ------------------------------
        // Two MVP-style callouts for the end-of-match screen:
        //   * the VILLAGER whose day votes landed on werewolves most often
        //   * the WOLF whose kills took the most power roles
        // Computed from the roster we already fetched, so the hot poll path pays
        // nothing and only the 'ended' frame does this tiny loop.
        $mvpVillager = null;
        $mvpWolf = null;
        if (($room['status'] ?? '') === 'ended') {
            // In Chaos the wolves' headline stat is raw damage dealt (they rarely
            // one-shot a power role); in Classic it stays power roles removed.
            $chaos = (validMode($room['mode'] ?? '') === MODE_CHAOS);
            foreach ($players as $p) {
                $isWolf = ($p['role'] === 'Werewolf');
                $wv = (int)($p['wolf_votes'] ?? 0);
                $sk = $chaos ? (int)($p['damage_done'] ?? 0) : (int)($p['special_kills'] ?? 0);
                if (!$isWolf && $wv > 0 && (!$mvpVillager || $wv > $mvpVillager['count'])) {
                    $mvpVillager = [
                        'name'   => $p['nickname'],
                        'avatar' => $p['avatar'] ?: 'paw',
                        'count'  => $wv,
                    ];
                }
                if ($isWolf && $sk > 0 && (!$mvpWolf || $sk > $mvpWolf['count'])) {
                    $mvpWolf = [
                        'name'   => $p['nickname'],
                        'avatar' => $p['avatar'] ?: 'paw',
                        'count'  => $sk,
                        'unit'   => $chaos ? 'dmg' : 'roles',
                    ];
                }
            }
        }

        echo json_encode([
            "status" => "success",
            "winner" => $room['winner'] ?? '',
            // Game mode + MY OWN vitals only. Other seats' HP is never sent.
            "mode" => validMode($room['mode'] ?? ''),
            "my_hp" => $myHp,
            "my_max_hp" => $myMaxHp,
            "my_hp_delta" => $myHpDelta,
            "my_heal_target" => $myHealTarget,
            "my_seer_hp" => $mySeerHp,
            // How hard the pack is biting THIS seat right now (0 = not attacked).
            "incoming_damage" => $incomingDamage,
            "mvp_villager" => $mvpVillager,
            "mvp_wolf" => $mvpWolf,

            // Fingerprint of everything the client can see, so the next poll can
            // long-poll against it (see the wait loop at the top of this handler).
            "state_sig" => wolfStateSig($pdo, $roomCode),
            "room_status" => $room['status'],
            "is_host" => ($room['host_token'] === $token),
            "is_match" => (int)($room['is_match'] ?? 0),
            "mm_remaining" => $mmRemaining,
            "server_now" => $serverNow,
            "mm_started_at" => $mmStartedAt,
            "started_at" => (int)($room['started_at'] ?? 0),
            "phase_started_at" => (int)($room['phase_started_at'] ?? 0),
            "pre_night_seconds" => 15,
            "max_players" => (int)$room['max_players'],
            "current_count" => count($players),
            "players" => $playerData,
            "role_breakdown" => $roleBreakdown,
            "my_role" => $myRole,
            "my_id" => $myId,
            "is_alive" => $isAlive,
            "my_target_id" => $myTargetId,
            "my_vote_id" => $myVoteId,
            "has_voted" => $hasVoted,
            "night_step" => $room['night_step'] ?? 'actions',
            "my_check_target" => $myCheckTarget,
            "my_seer_target" => $mySeerTarget,
            "my_seer_target_name" => $mySeerTargetName,
            "my_seer_result" => $mySeerResult,
            "my_poison_target" => $myPoisonTarget,
            "my_poison_used" => $myPoisonUsed,
            "my_poison_skip" => $myPoisonSkip,
            "my_revive_used" => $myReviveUsed,
            "my_doctor_choice" => $myDoctorChoice,
            "my_asleep" => $myAsleep,
            "my_vote_skip" => $myVoteSkip,
            // Account info (null for guests) + what this match did to my rank.
            "me" => authUserPublic($authUser),
            "my_user_id" => $myUserId,
            "my_rating_delta" => $myRatingDelta,
            "my_user_won" => $myUserWon,
            "my_xp_delta" => $myXpDelta,
            "doctor_victim_name" => $doctorVictimName,
            "voice_signals" => $voiceSignals,
            "last_event" => $room['last_event'] ?? '',
            // Resolved day-vote outcome ({"outcome":"lynched|tie|skip",...}) so
            // the client can play the vote-result cutscene on the day->night edge.
            "last_vote" => (!empty($room['last_vote']) ? json_decode($room['last_vote'], true) : null),
            "messages" => $messages
        ]);
}
function handleNightAction(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $targetId = (int)($_POST['target_id'] ?? 0);
        $skip = (int)($_POST['skip'] ?? 0);
        $sleep = (int)($_POST['sleep'] ?? 0);

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'night') {
            echo json_encode(["status" => "error", "message" => "It is not night phase."]);
            exit;
        }
        $mode = validMode($room['mode'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me || $me['is_alive'] == 0) {
            echo json_encode(["status" => "error", "message" => "You are dead or invalid."]);
            exit;
        }

        $myId = (int)$me['id'];

        // "Sleep": anyone may tap it, and everyone WITHOUT a night action
        // (villagers + the Doctor) is required to — their taps mask the sound of
        // the werewolf's kill tap when friends are on a voice call.
        if ($sleep) {
            $pdo->prepare("UPDATE players SET asleep = 1 WHERE id = ?")->execute([$myId]);
            advanceNight($pdo, $roomCode);
            echo json_encode(["status" => "success", "message" => "You drift off to sleep."]);
            exit;
        }

        if ($me['role'] === 'Werewolf') {
            // Werewolves secretly vote for tonight's victim. Never trust the
            // client's id — a stale tab can offer a corpse as the target.
            if ($targetId > 0 && !validLiveTarget($pdo, $roomCode, $targetId)) {
                echo json_encode(["status" => "error", "message" => "That player is no longer available."]);
                exit;
            }
            $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$targetId, $myId]);

        } elseif ($me['role'] === 'Seer') {
            // Divine one player: learn whether they are a werewolf.
            if ($targetId <= 0) {
                echo json_encode(["status" => "error", "message" => "Pick a player to divine."]);
                exit;
            }
            $t = $pdo->prepare("SELECT id, role, hp FROM players WHERE id = ? AND room_code = ? AND is_alive = 1");
            $t->execute([$targetId, $roomCode]);
            $target = $t->fetch();
            if (!$target) {
                echo json_encode(["status" => "error", "message" => "Invalid target."]);
                exit;
            }
            if ($mode === MODE_CHAOS) {
                // Chaos: the Seer reads the REAL role and the target's CURRENT HP.
                // This is the only way anyone ever sees another player's HP.
                $hp = ($target['hp'] === null) ? CHAOS_HP : (int)$target['hp'];
                $pdo->prepare("UPDATE players SET check_target = ?, seer_target = ?, seer_result = ?, seer_hp = ? WHERE id = ?")
                    ->execute([$targetId, $targetId, $target['role'], $hp, $myId]);
            } else {
                $result = ($target['role'] === 'Werewolf') ? 'wolf' : 'good';
                $pdo->prepare("UPDATE players SET check_target = ?, seer_target = ?, seer_result = ? WHERE id = ?")
                    ->execute([$targetId, $targetId, $result, $myId]);
            }

        } elseif ($me['role'] === 'Witch') {
            // One poison per game. Either name a victim or explicitly pass.
            if ((int)$me['poison_used']) {
                echo json_encode(["status" => "error", "message" => "Your poison is already spent."]);
                exit;
            }
            if ($skip) {
                $pdo->prepare("UPDATE players SET poison_skip = 1 WHERE id = ?")->execute([$myId]);
            } else {
                if ($targetId <= 0) {
                    echo json_encode(["status" => "error", "message" => "Pick a player to poison, or skip."]);
                    exit;
                }
                if ($targetId === $myId) {
                    echo json_encode(["status" => "error", "message" => "You cannot poison yourself."]);
                    exit;
                }
                if (!validLiveTarget($pdo, $roomCode, $targetId)) {
                    echo json_encode(["status" => "error", "message" => "That player is no longer available."]);
                    exit;
                }
                $pdo->prepare("UPDATE players SET poison_target = ? WHERE id = ?")->execute([$targetId, $myId]);
            }

        } elseif ($me['role'] === 'Doctor' && $mode === MODE_CHAOS) {
            // Chaos: a BLIND nightly heal. The Doctor is never told whether the
            // target needed it, or even whether they were attacked at all.
            if ($skip) {
                $pdo->prepare("UPDATE players SET heal_target = NULL, doctor_choice = 0 WHERE id = ?")->execute([$myId]);
            } else {
                if ($targetId <= 0) {
                    echo json_encode(["status" => "error", "message" => "Pick a player to treat, or hold."]);
                    exit;
                }
                if (!validLiveTarget($pdo, $roomCode, $targetId)) {
                    echo json_encode(["status" => "error", "message" => "That player is no longer available."]);
                    exit;
                }
                $pdo->prepare("UPDATE players SET heal_target = ?, doctor_choice = 1 WHERE id = ?")->execute([$targetId, $myId]);
            }
        } else {
            // Villagers have no action in this step.
            echo json_encode(["status" => "success", "message" => "Nothing to do."]);
            exit;
        }

        // Advance the night if every night actor has now finished.
        advanceNight($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => "Night action submitted."]);
}
function handleDoctorAction(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $revive = (int)($_POST['revive'] ?? 0);

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'night' || ($room['night_step'] ?? '') !== 'doctor') {
            echo json_encode(["status" => "error", "message" => "There is no revive decision to make right now."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me || $me['role'] !== 'Doctor' || $me['is_alive'] == 0) {
            echo json_encode(["status" => "error", "message" => "Only the living Doctor may decide."]);
            exit;
        }

        $pdo->prepare("UPDATE players SET doctor_choice = ? WHERE id = ?")->execute([$revive ? 1 : 0, (int)$me['id']]);

        advanceNight($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => $revive ? "You chose to save them." : "You chose not to intervene."]);
}
function handleDayVote(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');
        $voteId = (int)($_POST['vote_id'] ?? 0);
        $skip = (int)($_POST['skip'] ?? 0);

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['status'] !== 'day') {
            echo json_encode(["status" => "error", "message" => "It is not day voting phase."]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT * FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if (!$me || $me['is_alive'] == 0) {
            echo json_encode(["status" => "error", "message" => "You are dead and cannot vote."]);
            exit;
        }

        // Your own seat is not a valid target. The roster used to offer a Vote button
        // on your own card, and the server accepted it as an ordinary vote for you —
        // which both padded your own count and helped manufacture the all-tied days
        // that stopped the village from ever lynching anyone.
        if (!$skip && $voteId === (int)$me['id']) {
            echo json_encode(["status" => "error", "message" => "You cannot vote for yourself."]);
            exit;
        }

        if ($skip) {
            // Abstain. Tallied as a "skip" vote at the end of the day: if the
            // skip count beats the highest vote count, nobody is executed.
            $stmt = $pdo->prepare("UPDATE players SET vote_id = NULL, vote_skip = 1 WHERE id = ?");
            $stmt->execute([$me['id']]);
        } else {
            // NEVER trust the client's target id. A backgrounded tab can still be
            // rendering a roster from before someone died, and a vote aimed at a
            // corpse used to be accepted, counted, and could "execute" a player
            // who was already dead — wasting the village's entire day.
            if (!validLiveTarget($pdo, $roomCode, $voteId)) {
                echo json_encode(["status" => "error", "message" => "That player is no longer available to vote for. Refreshing…"]);
                exit;
            }
            $stmt = $pdo->prepare("UPDATE players SET vote_id = ?, vote_skip = 0 WHERE id = ?");
            $stmt->execute([$voteId, $me['id']]);
        }

        // Bots may have already voted; resolve if everyone acted.
        processDayBots($pdo, $roomCode);
        resolveDay($pdo, $roomCode);

        // Hand the voter the AUTHORITATIVE tally in this very response. The client
        // moves the count the instant the tap lands, but without this it then had to
        // wait for a poll cycle to confirm it — which is what made the vote count sit
        // stale for ~half a second. Two cheap reads on a path that has already paid a
        // ~270ms InnoDB fsync, so it costs nothing measurable.
        $tally = dayVoteTally($pdo, $roomCode);   // same rule the resolver uses
        $sq = $pdo->prepare("SELECT status FROM rooms WHERE room_code = ?");
        $sq->execute([$roomCode]);
        $statusNow = (string)$sq->fetchColumn();

        echo json_encode([
            "status" => "success",
            "message" => $skip ? "You skipped your vote." : "Vote submitted.",
            "votes" => $tally,
            "my_vote_id" => $skip ? null : $voteId,
            "has_voted" => true,
            "my_vote_skip" => $skip ? 1 : 0,
            "room_status" => $statusNow
        ]);
}
