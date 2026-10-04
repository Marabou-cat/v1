<?php
/* werewolf / lib/actions-room.php - action handlers: create_room, matchmake, join_room, leave_room, start_game
   Each was formerly a `case` body in backend.php's switch; each
   receives $pdo and echoes its own JSON response. */

function handleCreateRoom(PDO $pdo) {
$nickname = trim($_POST['nickname'] ?? 'Host');
        $maxPlayers = (int)($_POST['max_players'] ?? 4);

        if ($maxPlayers < 4) {
            echo json_encode(["status" => "error", "message" => "Room must allow at least 4 players.", "cutscene" => "scene_error"]);
            exit;
        }

        $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
        $sessionToken = bin2hex(random_bytes(16));

        $mode = validMode($_POST['mode'] ?? '');
        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, status, mode) VALUES (?, ?, ?, 'lobby', ?)");
        $stmt->execute([$roomCode, $sessionToken, $maxPlayers, $mode]);

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive, avatar) VALUES (?, ?, ?, 1, ?)");
        $stmt->execute([$roomCode, $sessionToken, $nickname, seatAvatar($pdo)]);
        touchPresence($pdo, $roomCode, $sessionToken);

        echo json_encode([
            "status" => "success",
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "max_players" => $maxPlayers,
            "message" => "Room created! Share your code.",
            "cutscene" => "scene_room_created"
        ]);
}
function handleMatchmake(PDO $pdo) {
$nickname = trim($_POST['nickname'] ?? 'Player');
        $count = (int)($_POST['count'] ?? 0);
        // Modes must NEVER mix — a classic player dropped into a Chaos table (or
        // vice versa) would see a completely broken game. Every queue lookup and
        // room creation below is scoped to this.
        $mode = validMode($_POST['mode'] ?? '');

        if ($count < 4 || $count > 10) {
            echo json_encode(["status" => "error", "message" => "Choose 4 to 10 players."]);
            exit;
        }

        // Clear out dead lobbies first so we never match into a ghost room.
        reapStaleRooms($pdo);

        // 1) Join an existing matchmade lobby that wants exactly this count AND
        //    actually has a live human waiting (last_seen recent). Rooms whose
        //    only occupants closed the tab are skipped — that is what used to
        //    match two live players into different abandoned rooms.
        $stmt = $pdo->prepare("SELECT r.* FROM rooms r
            WHERE r.is_match = 1 AND r.status = 'lobby' AND r.max_players = ? AND r.mode = ?
              AND EXISTS (SELECT 1 FROM players p
                          WHERE p.room_code = r.room_code AND p.is_bot = 0 AND p.last_seen >= ?)
            ORDER BY r.created_at ASC");
        $stmt->execute([$count, $mode, time() - PLAYER_TIMEOUT]);
        $candidates = $stmt->fetchAll();

        foreach ($candidates as $room) {
            // Join under a room-row lock so a concurrent bot top-up can't race
            // this insert and overfill the lobby.
            $sessionToken = bin2hex(random_bytes(16));
            $joined = false;
            try {
                $pdo->beginTransaction();
                $pdo->prepare("SELECT room_code FROM rooms WHERE room_code = ? FOR UPDATE")->execute([$room['room_code']]);
                $cc = $pdo->prepare("SELECT COUNT(*) AS c FROM players WHERE room_code = ?");
                $cc->execute([$room['room_code']]);
                if ((int)$cc->fetch()['c'] < (int)$room['max_players']) {
                    // Defensive: clear any stale same-nickname seat so a player
                    // can't duplicate themselves when re-queueing.
                    $pdo->prepare("DELETE FROM players WHERE room_code = ? AND nickname = ?")->execute([$room['room_code'], $nickname]);
                    $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive, avatar) VALUES (?, ?, ?, 1, ?)")
                        ->execute([$room['room_code'], $sessionToken, $nickname, seatAvatar($pdo)]);
                    $joined = true;
                }
                $pdo->commit();
            } catch (Exception $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $e;
            }
            if (!$joined) continue;

            touchPresence($pdo, $room['room_code'], $sessionToken);

            echo json_encode([
                "status" => "success",
                "joined" => true,
                "room_code" => $room['room_code'],
                "token" => $sessionToken,
                "max_players" => (int)$room['max_players'],
                "server_now" => time(),
                "mm_started_at" => max(0, (int)$room['mm_deadline'] - MATCH_WAIT_SECONDS),
                "message" => "Matched with a waiting lobby!",
                "cutscene" => "scene_door_open"
            ]);
            exit;
        }

        // 2) Nobody waiting at this size: note the nearest busy size so the
        //    client can offer a quick switch. Only sizes with a live human
        //    count — otherwise we'd dangle a non-existent room in front of the
        //    player ("a 10-player lobby is waiting" that is actually empty).
        $stmt = $pdo->prepare("SELECT r.max_players FROM rooms r
            WHERE r.is_match = 1 AND r.status = 'lobby' AND r.mode = ?
              AND EXISTS (SELECT 1 FROM players p
                          WHERE p.room_code = r.room_code AND p.is_bot = 0 AND p.last_seen >= ?)
            GROUP BY r.max_players");
        $stmt->execute([$mode, time() - PLAYER_TIMEOUT]);
        $busySizes = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $suggest = null;
        $best = PHP_INT_MAX;
        foreach ($busySizes as $mp) {
            $diff = abs((int)$mp - $count);
            if ($diff < $best) { $best = $diff; $suggest = (int)$mp; }
        }

        // 3) Create a fresh matchmade room with a 30s fill deadline.
        $roomCode = strtoupper(substr(bin2hex(random_bytes(3)), 0, 5));
        $sessionToken = bin2hex(random_bytes(16));
        // One timestamp drives both the deadline and the shared match clock, so
        // a joiner (mm_deadline - MATCH_WAIT_SECONDS) and the creator always
        // agree on when the queue started.
        $mmStartedAt = time();

        $stmt = $pdo->prepare("INSERT INTO rooms (room_code, host_token, max_players, status, is_match, mm_deadline, mode) VALUES (?, ?, ?, 'lobby', 1, ?, ?)");
        $stmt->execute([$roomCode, $sessionToken, $count, $mmStartedAt + MATCH_WAIT_SECONDS, $mode]);

        $stmt = $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive, avatar) VALUES (?, ?, ?, 1, ?)");
        $stmt->execute([$roomCode, $sessionToken, $nickname, seatAvatar($pdo)]);
        touchPresence($pdo, $roomCode, $sessionToken);

        $payload = [
            "status" => "success",
            "joined" => false,
            "created" => true,
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "max_players" => $count,
            "mode" => $mode,
            "mm_wait_seconds" => MATCH_WAIT_SECONDS,
            "message" => "No open lobby for " . $count . " players. You are first — waiting for others (bots fill the room if it is not full in " . MATCH_WAIT_SECONDS . "s)."
        ];
        if ($suggest !== null && $suggest !== $count) {
            $payload["suggest_count"] = $suggest;
        }
        $payload["server_now"] = time();
        $payload["mm_started_at"] = $mmStartedAt;
        echo json_encode($payload);
}
function handleJoinRoom(PDO $pdo) {
$nickname = trim($_POST['nickname'] ?? 'Villager');
        $roomCode = strtoupper(trim($_POST['room_code'] ?? ''));

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room) {
            echo json_encode(["status" => "error", "message" => "Room code not found.", "cutscene" => "scene_error"]);
            exit;
        }

        if ($room['status'] !== 'lobby') {
            echo json_encode(["status" => "error", "message" => "Game is already in progress.", "cutscene" => "scene_error"]);
            exit;
        }

        $sessionToken = bin2hex(random_bytes(16));

        // Cap the room under a row lock so a bot top-up can't race this insert
        // and push the room over max_players.
        $roomFull = false;
        try {
            $pdo->beginTransaction();
            $pdo->prepare("SELECT room_code FROM rooms WHERE room_code = ? FOR UPDATE")->execute([$roomCode]);
            $cc = $pdo->prepare("SELECT COUNT(*) as c FROM players WHERE room_code = ?");
            $cc->execute([$roomCode]);
            if ((int)$cc->fetch()['c'] >= (int)$room['max_players']) {
                $roomFull = true;
            } else {
                // Drop any stale leftover entry with the same nickname in this
                // lobby (a previous session that crashed before leaving), so a
                // player can never "duplicate" themselves by rejoining.
                $pdo->prepare("DELETE FROM players WHERE room_code = ? AND nickname = ?")->execute([$roomCode, $nickname]);
                $pdo->prepare("INSERT INTO players (room_code, session_token, nickname, is_alive, avatar) VALUES (?, ?, ?, 1, ?)")
                    ->execute([$roomCode, $sessionToken, $nickname, seatAvatar($pdo)]);
            }
            $pdo->commit();
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        if ($roomFull) {
            echo json_encode(["status" => "error", "message" => "Room is full!", "cutscene" => "scene_error"]);
            exit;
        }
        touchPresence($pdo, $roomCode, $sessionToken);

        echo json_encode([
            "status" => "success",
            "room_code" => $roomCode,
            "token" => $sessionToken,
            "message" => "Welcome to the village!",
            "cutscene" => "scene_door_open"
        ]);
}
function handleLeaveRoom(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        if ($roomCode === '' || $token === '') {
            echo json_encode(["status" => "success", "message" => "Nothing to leave."]);
            exit;
        }

        // hp/max_hp + the settlement stats are read so a mid-game replacement bot
        // can inherit the WHOLE seat (see below) — not just the role.
        $stmt = $pdo->prepare("SELECT id, room_code, role, is_bot, is_alive, hp, max_hp, damage_done, wolf_votes, special_kills FROM players WHERE room_code = ? AND session_token = ?");
        $stmt->execute([$roomCode, $token]);
        $me = $stmt->fetch();

        if ($me) {
            // Remove this player's chat so the room history stays clean.
            $stmt = $pdo->prepare("DELETE FROM messages WHERE room_code = ? AND sender_name = (SELECT nickname FROM players WHERE id = ?)");
            $stmt->execute([$me['room_code'], $me['id']]);

            // Remove the player itself.
            $stmt = $pdo->prepare("DELETE FROM players WHERE id = ?");
            $stmt->execute([$me['id']]);

            // Keep a full, balanced table: if a LIVING player leaves
            // mid-game, seat a bot with the SAME role in their place. This
            // is what stops the "no werewolf left / unbalanced" tables —
            // e.g. a human werewolf quitting no longer leaves a 0-wolf room
            // that instantly ends "Villagers win".
            if ((int)$me['is_bot'] === 0 && (int)$me['is_alive'] === 1) {
                $ri = $pdo->prepare("SELECT status FROM rooms WHERE room_code = ?");
                $ri->execute([$roomCode]);
                $roomInfo = $ri->fetch();
                if ($roomInfo && in_array($roomInfo['status'], ['night', 'day'], true)
                    && !empty($me['role']) && $me['role'] !== 'unassigned') {
                    $bot = addBot($pdo, $roomCode);
                    if ($bot) {
                        // Inherit the leaver's FULL seat state, not just the role.
                        // In Chaos Night a replacement that only copied the role had
                        // no HP pool at all — a living player with no vitals (its own
                        // HP bar could never render) plus reset damage stats.
                        // In Classic hp/max_hp are NULL, so this is a no-op there.
                        $pdo->prepare("UPDATE players SET role = ?, bot_last_chat = 0,
                                         hp = ?, max_hp = ?, damage_done = ?, wolf_votes = ?, special_kills = ?
                                       WHERE id = ?")
                            ->execute([$me['role'], $me['hp'], $me['max_hp'],
                                       (int)($me['damage_done'] ?? 0), (int)($me['wolf_votes'] ?? 0),
                                       (int)($me['special_kills'] ?? 0), $bot['id']]);
                        $pdo->prepare("UPDATE rooms SET last_event = ? WHERE room_code = ?")
                            ->execute(["A new villager slipped into the seat...", $roomCode]);
                    }
                }
            }
        }

        // If a lobby is now empty, dissolve the room entirely (codes are
        // one-shot, so an empty lobby has no reason to live on).
        $stmt = $pdo->prepare("SELECT status, (SELECT COUNT(*) FROM players WHERE room_code = ?) AS pc FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode, $roomCode]);
        $room = $stmt->fetch();
        if ($room && $room['status'] === 'lobby' && (int)$room['pc'] === 0) {
            $pdo->prepare("DELETE FROM messages WHERE room_code = ?")->execute([$roomCode]);
            $pdo->prepare("DELETE FROM rooms WHERE room_code = ?")->execute([$roomCode]);
        }

        echo json_encode(["status" => "success", "message" => "You have left the room."]);
}
function handleStartGame(PDO $pdo) {
$roomCode = strtoupper(trim($_POST['room_code'] ?? ''));
        $token = trim($_POST['token'] ?? '');

        $stmt = $pdo->prepare("SELECT * FROM rooms WHERE room_code = ?");
        $stmt->execute([$roomCode]);
        $room = $stmt->fetch();

        if (!$room || $room['host_token'] !== $token) {
            echo json_encode(["status" => "error", "message" => "Only the room host can start the game.", "cutscene" => "scene_error"]);
            exit;
        }

        $stmt = $pdo->prepare("SELECT id FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();
        $total = count($players);

        if ($total < 4) {
            echo json_encode(["status" => "error", "message" => "At least 4 players are required to start.", "cutscene" => "scene_error"]);
            exit;
        }

        beginGame($pdo, $roomCode);

        $rs = $pdo->prepare("SELECT started_at FROM rooms WHERE room_code = ?");
        $rs->execute([$roomCode]);
        $rd = $rs->fetch();

        echo json_encode([
            "status" => "success",
            "message" => "Cards dealt! Night falls upon the village...",
            "cutscene" => "scene_night_falls",
            "server_now" => time(),
            "started_at" => (int)($rd['started_at'] ?? 0)
        ]);
}
