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
        $stmt = $pdo->prepare("SELECT id, nickname, session_token, role, is_alive, target_id, vote_id, is_bot, bot_ready_at, bot_last_chat, check_target, seer_target, seer_result, poison_target, poison_skip, poison_used, revive_used, doctor_choice, asleep, voice_on FROM players WHERE room_code = ? ORDER BY id ASC");
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

        $myRole = 'unassigned';
        $myId = null;
        $isAlive = 1;
        $myTargetId = null;
        $myVoteId = null;
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

                if ($room['status'] === 'night' && $p['role'] === 'Werewolf') {
                    $hasVoted = ($p['target_id'] !== null);
                } elseif ($room['status'] === 'day') {
                    $hasVoted = ($p['vote_id'] !== null);
                }
                break;
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
        if ($myRole === 'Doctor' && $isAlive && ($room['night_step'] ?? '') === 'doctor' && (int)($room['pending_victim'] ?? 0) > 0) {
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
                $stmt = $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'Villagers win! All werewolves have been eliminated.' WHERE room_code = ?");
                $stmt->execute([$roomCode]);
                $room['status'] = 'ended';
                $room['last_event'] = 'Villagers win! All werewolves have been eliminated.';
            } elseif ($aliveWerewolves >= $aliveVillagersOrSpecials) {
                $stmt = $pdo->prepare("UPDATE rooms SET status = 'ended', last_event = 'Werewolves win! They have outnumbered the villagers.' WHERE room_code = ?");
                $stmt->execute([$roomCode]);
                $room['status'] = 'ended';
                $room['last_event'] = 'Werewolves win! They have outnumbered the villagers.';
            }
        }

        // Live vote tally — only counted (and only revealed) during the day, so
        // the roster can show each player's running vote count.
        $voteTally = [];
        if ($room['status'] === 'day') {
            foreach ($players as $p) {
                if ($p['vote_id'] !== null) {
                    $voteTally[(int)$p['vote_id']] = ($voteTally[(int)$p['vote_id']] ?? 0) + 1;
                }
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
                "is_alive" => $isAlive,
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

        echo json_encode([
            "status" => "success",
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
            "doctor_victim_name" => $doctorVictimName,
            "voice_signals" => $voiceSignals,
            "last_event" => $room['last_event'] ?? '',
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
            // Werewolves secretly vote for tonight's victim.
            $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$targetId, $myId]);

        } elseif ($me['role'] === 'Seer') {
            // Divine one player: learn whether they are a werewolf.
            if ($targetId <= 0) {
                echo json_encode(["status" => "error", "message" => "Pick a player to divine."]);
                exit;
            }
            $t = $pdo->prepare("SELECT id, role FROM players WHERE id = ? AND room_code = ? AND is_alive = 1");
            $t->execute([$targetId, $roomCode]);
            $target = $t->fetch();
            if (!$target) {
                echo json_encode(["status" => "error", "message" => "Invalid target."]);
                exit;
            }
            $result = ($target['role'] === 'Werewolf') ? 'wolf' : 'good';
            $pdo->prepare("UPDATE players SET check_target = ?, seer_target = ?, seer_result = ? WHERE id = ?")
                ->execute([$targetId, $targetId, $result, $myId]);

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
                $pdo->prepare("UPDATE players SET poison_target = ? WHERE id = ?")->execute([$targetId, $myId]);
            }

        } else {
            // Villagers and the Doctor have no action in this step.
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

        $stmt = $pdo->prepare("UPDATE players SET vote_id = ? WHERE id = ?");
        $stmt->execute([$voteId, $me['id']]);

        // Bots may have already voted; resolve if everyone acted.
        processDayBots($pdo, $roomCode);
        resolveDay($pdo, $roomCode);

        echo json_encode(["status" => "success", "message" => "Vote submitted."]);
}
