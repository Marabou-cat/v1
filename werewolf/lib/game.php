<?php
/* werewolf / lib/game.php - beginGame, resetNightState, nightActionsComplete, computeWolfVictim, advanceNight, finalizeNight, resolveDay
   Included by backend.php into its scope (shares $pdo and constants).
   Split out of the old monolithic backend.php. */

function beginGame(PDO $pdo, $roomCode) {
    $pdo->beginTransaction();
    try {
        $claim = $pdo->prepare("UPDATE rooms SET status = 'night' WHERE room_code = ? AND status = 'lobby'");
        $claim->execute([$roomCode]);
        if ((int)$claim->rowCount() === 0) {
            $pdo->rollBack();
            return; // already started by another poll (its deal is committed)
        }

        $stmt = $pdo->prepare("SELECT id, is_bot FROM players WHERE room_code = ? ORDER BY id ASC");
        $stmt->execute([$roomCode]);
        $players = $stmt->fetchAll();

        // Defensive: a concurrent fill/join could have overshot max_players by
        // one. Never deal more seats than the room allows — drop the newest BOTS
        // first (never kick a human), then re-read.
        $mp = $pdo->prepare("SELECT max_players FROM rooms WHERE room_code = ?");
        $mp->execute([$roomCode]);
        $maxP = (int)$mp->fetchColumn();
        if ($maxP > 0 && count($players) > $maxP) {
            $overflow = count($players) - $maxP;
            for ($i = count($players) - 1; $i >= 0 && $overflow > 0; $i--) {
                if ((int)$players[$i]['is_bot'] === 1) {
                    $pdo->prepare("DELETE FROM players WHERE id = ?")->execute([$players[$i]['id']]);
                    $overflow--;
                }
            }
            $stmt = $pdo->prepare("SELECT id, is_bot FROM players WHERE room_code = ? ORDER BY id ASC");
            $stmt->execute([$roomCode]);
            $players = $stmt->fetchAll();
        }
        $total = count($players);

        $breakdown = calculateRoles($total);
        if ($breakdown === null || $total < 4) {
            $pdo->rollBack();
            return;
        }
        $deck = array_fill(0, $breakdown['werewolves'], 'Werewolf');
        foreach ($breakdown['special_cards'] as $card) {
            $deck[] = $card;
        }
        while (count($deck) < $total) {
            $deck[] = 'Villager';
        }
        shuffle($deck);

        foreach ($players as $index => $player) {
            // bot_ready_at is reset to NULL so each bot re-arms its own random
            // "thinking" delay on the very first night (see processNightBots).
            $stmt = $pdo->prepare("UPDATE players SET role = ?, is_alive = 1, target_id = NULL, vote_id = NULL, bot_ready_at = NULL WHERE id = ?");
            $stmt->execute([$deck[$index], $player['id']]);
        }

        $now = time();
        $stmt = $pdo->prepare("UPDATE rooms SET status = 'night', last_event = 'Night falls upon the village...', started_at = ?, phase_started_at = ? WHERE room_code = ?");
        $stmt->execute([$now, $now, $roomCode]);
        // Arm the first night's skill state (clears per-night fields, sets deadline).
        resetNightState($pdo, $roomCode);

        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// Night AI: every alive bot acts with a random 2-8s "thinking" delay so the
// actions trickle in like real players. Wolves lock a victim (preferring a
// non-werewolf), the Seer divines a random player, the Witch may spend her
// one poison (or pass). Does NOT resolve the phase — advanceNight() does that.
function resetNightState(PDO $pdo, $roomCode) {
    $pdo->prepare("UPDATE players SET target_id = NULL, check_target = NULL, poison_target = NULL, poison_skip = 0, doctor_choice = NULL, asleep = 0 WHERE room_code = ?")
        ->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET night_step = 'actions', pending_victim = NULL, night_deadline = ? WHERE room_code = ?")
        ->execute([time() + NIGHT_SECONDS, $roomCode]);
}

// Has every night actor finished? Alive wolves must have locked a victim,
// an alive Seer must have divined, an alive Witch must have spent or passed
// her poison, and everyone with NO night action (villagers + the Doctor) must
// have tapped "sleep" (which also masks the sound of the kill tap on a call).
function nightActionsComplete(PDO $pdo, $roomCode) {
    $s = $pdo->prepare("SELECT role, target_id, check_target, poison_target, poison_skip, poison_used, asleep
                          FROM players WHERE room_code = ? AND is_alive = 1");
    $s->execute([$roomCode]);
    foreach ($s->fetchAll() as $p) {
        if ($p['role'] === 'Werewolf') {
            if ($p['target_id'] === null) return false;
        } elseif ($p['role'] === 'Seer') {
            if ($p['check_target'] === null) return false;
        } elseif ($p['role'] === 'Witch') {
            if (!(int)$p['poison_used'] && $p['poison_target'] === null && !(int)$p['poison_skip']) return false;
        } else {
            // Villager / Doctor: must bunk down before the night resolves.
            if (!(int)$p['asleep']) return false;
        }
    }
    return true;
}

// The werewolves' majority victim among targets that are still alive (null if none).
function computeWolfVictim(PDO $pdo, $roomCode) {
    $s = $pdo->prepare("SELECT target_id FROM players WHERE room_code = ? AND role = 'Werewolf' AND is_alive = 1 AND target_id IS NOT NULL");
    $s->execute([$roomCode]);
    $targets = $s->fetchAll(PDO::FETCH_COLUMN);
    if (count($targets) === 0) return null;

    $a = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1");
    $a->execute([$roomCode]);
    $alive = array_flip($a->fetchAll(PDO::FETCH_COLUMN));

    $counts = [];
    foreach ($targets as $id) { $counts[$id] = ($counts[$id] ?? 0) + 1; }
    $best = null; $bestN = 0;
    foreach ($counts as $id => $n) {
        if (!isset($alive[$id])) continue;
        if ($n > $bestN) { $bestN = $n; $best = (int)$id; }
    }
    return $best;
}

// Drive the night forward (called from poll_game while status == 'night').
// Step order: 'actions' (wolves + Seer + Witch) → 'doctor' (revive window) →
// finalize. Returns true if the phase advanced to day.
function advanceNight(PDO $pdo, $roomCode) {
    $now = time();
    $r = $pdo->prepare("SELECT status, night_step, night_deadline FROM rooms WHERE room_code = ?");
    $r->execute([$roomCode]);
    $room = $r->fetch();
    if (!$room || $room['status'] !== 'night') return false;

    // ---- Doctor step: waiting on the revive decision ----
    if ($room['night_step'] === 'doctor') {
        processDoctorBot($pdo, $roomCode);
        $d = $pdo->prepare("SELECT doctor_choice FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1");
        $d->execute([$roomCode]);
        $doc = $d->fetch();
        $decided = (!$doc) || ($doc['doctor_choice'] !== null);
        if ($decided || $now >= (int)$room['night_deadline']) {
            return finalizeNight($pdo, $roomCode);
        }
        return false;
    }

    // ---- Actions step ----
    processNightBots($pdo, $roomCode);
    $timedOut = ($now >= (int)$room['night_deadline']);
    if (!nightActionsComplete($pdo, $roomCode) && !$timedOut) return false;

    // Timeout safety: give any silent wolf a random target so the night still
    // resolves (an AFK werewolf must not stall the game forever).
    if ($timedOut) {
        $ws = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND role = 'Werewolf' AND is_alive = 1 AND target_id IS NULL");
        $ws->execute([$roomCode]);
        foreach ($ws->fetchAll(PDO::FETCH_COLUMN) as $wid) {
            $o = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND is_alive = 1 AND id != ? ORDER BY RAND() LIMIT 1");
            $o->execute([$roomCode, $wid]);
            $tid = $o->fetchColumn();
            if ($tid) $pdo->prepare("UPDATE players SET target_id = ? WHERE id = ?")->execute([$tid, $wid]);
        }
    }

    $victimId = computeWolfVictim($pdo, $roomCode);

    // If a living Doctor still holds their revive, hand them the victim first.
    $d = $pdo->prepare("SELECT id FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1 AND revive_used = 0 LIMIT 1");
    $d->execute([$roomCode]);
    $hasDoctor = (bool)$d->fetch();

    if ($victimId && $hasDoctor) {
        $pdo->prepare("UPDATE rooms SET night_step = 'doctor', pending_victim = ?, night_deadline = ? WHERE room_code = ?")
            ->execute([$victimId, $now + DOCTOR_SECONDS, $roomCode]);
        return false; // wait for the Doctor's revive decision
    }

    // Persist the victim so finalizeNight can apply it — it reads
    // rooms.pending_victim, which is NULL after resetNightState. (Without this
    // the werewolves killed nobody whenever there was no doctor step.)
    $pdo->prepare("UPDATE rooms SET pending_victim = ? WHERE room_code = ?")->execute([$victimId, $roomCode]);
    return finalizeNight($pdo, $roomCode);
}

// Apply the night's deaths (werewolf victim unless revived + Witch poison),
// write the narrative, clear all per-night state and flip to day.
function finalizeNight(PDO $pdo, $roomCode) {
    $now = time();
    $r = $pdo->prepare("SELECT pending_victim FROM rooms WHERE room_code = ?");
    $r->execute([$roomCode]);
    $row = $r->fetch();
    $victimId = $row ? (int)$row['pending_victim'] : 0;

    // Doctor revive — the once-per-game one-shot.
    $revived = false;
    $docId = 0;
    if ($victimId) {
        $d = $pdo->prepare("SELECT id, doctor_choice, revive_used FROM players WHERE room_code = ? AND role = 'Doctor' AND is_alive = 1");
        $d->execute([$roomCode]);
        $doc = $d->fetch();
        if ($doc && (int)$doc['doctor_choice'] === 1 && !(int)$doc['revive_used']) {
            $revived = true;
            $docId = (int)$doc['id'];
        }
    }

    $deaths = [];
    if ($victimId && !$revived) $deaths[$victimId] = true;

    // Witch poison (one-shot; spent once applied).
    $poisonId = 0;
    $w = $pdo->prepare("SELECT id, poison_target, poison_used FROM players WHERE room_code = ? AND role = 'Witch' AND poison_target IS NOT NULL LIMIT 1");
    $w->execute([$roomCode]);
    $witch = $w->fetch();
    if ($witch && !(int)$witch['poison_used'] && (int)$witch['poison_target'] > 0) {
        $poisonId = (int)$witch['poison_target'];
        $deaths[$poisonId] = true;
        $pdo->prepare("UPDATE players SET poison_used = 1 WHERE id = ?")->execute([$witch['id']]);
    }

    $nameOf = function ($id) use ($pdo, $roomCode) {
        $s = $pdo->prepare("SELECT nickname FROM players WHERE id = ? AND room_code = ?");
        $s->execute([$id, $roomCode]);
        $x = $s->fetch();
        return $x ? $x['nickname'] : 'Someone';
    };

    foreach (array_keys($deaths) as $id) {
        $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ? AND room_code = ?")->execute([$id, $roomCode]);
    }
    if ($revived && $docId) {
        $pdo->prepare("UPDATE players SET revive_used = 1 WHERE id = ?")->execute([$docId]);
    }

    // Narrative
    $parts = [];
    if ($victimId) {
        $vn = $nameOf($victimId);
        $parts[] = $revived
            ? "During the night, the werewolves attacked **{$vn}**, but the Doctor saved them!"
            : "During the night, the werewolves attacked and killed **{$vn}**!";
    } else {
        $parts[] = "The night passed quietly — nobody was attacked.";
    }
    if ($poisonId) $parts[] = "**" . $nameOf($poisonId) . "** was found dead, poisoned!";
    $event = implode(' ', $parts);

    // Clear per-night state and flip to day.
    $pdo->prepare("UPDATE players SET target_id = NULL, check_target = NULL, poison_target = NULL, poison_skip = 0, doctor_choice = NULL, asleep = 0, bot_ready_at = NULL WHERE room_code = ?")
        ->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'day', phase_started_at = ?, night_step = 'actions', pending_victim = NULL, night_deadline = 0, last_event = ? WHERE room_code = ?")
        ->execute([$now, $event, $roomCode]);
    return true;
}

// Resolve the day: every alive player has voted OR skipped -> apply the lynch
// rules, wipe the votes, flip to night. Returns true if the phase advanced.
//
// House rules (user-specified):
//   * two or more players tied on the highest vote count -> nobody is executed
//   * the skip count beats the highest vote count        -> nobody is executed
function resolveDay(PDO $pdo, $roomCode) {
    $stmt = $pdo->prepare("SELECT id, vote_id, vote_skip FROM players WHERE room_code = ? AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $living = $stmt->fetchAll();
    if (count($living) === 0) return false;

    $voteCounts = [];
    $skipCount = 0;
    foreach ($living as $p) {
        if ((int)$p['vote_skip']) { $skipCount++; continue; }
        if ($p['vote_id'] === null) return false;   // still waiting on somebody
        $voteCounts[(int)$p['vote_id']] = ($voteCounts[(int)$p['vote_id']] ?? 0) + 1;
    }

    arsort($voteCounts);
    $maxVotes = $voteCounts ? max($voteCounts) : 0;
    $tops = [];
    foreach ($voteCounts as $tid => $c) {
        if ($c === $maxVotes) $tops[] = (int)$tid; else break;
    }

    $outcome = 'skip';
    $lynchedId = 0;
    if (count($tops) >= 2) {
        $outcome = 'tie';
    } elseif ($skipCount > $maxVotes) {
        $outcome = 'skip';
    } elseif ($maxVotes > 0) {
        $outcome = 'lynched';
        $lynchedId = $tops[0];
    }
    // (all-skipped falls through to 'skip': maxVotes = 0, skipCount > 0)

    $lynchedName = '';
    $lynchedRole = '';
    if ($outcome === 'lynched') {
        $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ?")->execute([$lynchedId]);
        $stmt = $pdo->prepare("SELECT nickname, role FROM players WHERE id = ?");
        $stmt->execute([$lynchedId]);
        $row = $stmt->fetch();
        $lynchedName = $row ? $row['nickname'] : 'Someone';
        $lynchedRole = $row ? $row['role'] : 'Villager';
        $event = "The village voted and lynched **{$lynchedName}**. They were a **{$lynchedRole}**! Night falls again...";
    } elseif ($outcome === 'tie') {
        $event = 'The vote was tied — ' . count($tops) . ' players shared the most votes, so nobody was executed. Night falls again...';
    } else {
        $event = 'The village voted to skip' . ($skipCount > 0 ? " ({$skipCount} abstained)" : '')
               . ' — nobody was executed. Night falls again...';
    }

    $result = json_encode([
        'outcome' => $outcome,
        'votes'   => $maxVotes,
        'skipped' => $skipCount,
        'tied'    => count($tops),
        'name'    => $lynchedName,
        'role'    => $lynchedRole
    ]);

    $pdo->prepare("UPDATE players SET vote_id = NULL, vote_skip = 0 WHERE room_code = ?")->execute([$roomCode]);
    // New night: reset bot "thinking" timers so kills land at varying times.
    $pdo->prepare("UPDATE players SET bot_ready_at = NULL WHERE room_code = ? AND is_bot = 1")->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'night', phase_started_at = ?, last_event = ?, last_vote = ? WHERE room_code = ?")
        ->execute([time(), $event, $result, $roomCode]);
    // Arm the new night's skill state.
    resetNightState($pdo, $roomCode);
    return true;
}
