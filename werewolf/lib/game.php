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

        // Which ruleset this table plays. Rows created before v10 default to
        // 'classic', so nothing about the original game changes.
        $modeRow = $pdo->prepare("SELECT mode FROM rooms WHERE room_code = ?");
        $modeRow->execute([$roomCode]);
        $mode = validMode($modeRow->fetchColumn());

        $breakdown = calculateRoles($total, $mode);
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

        // Chaos tables start everyone at full HP; classic leaves the column NULL
        // (which is also how the client knows to hide the HP bar).
        $startHp = ($mode === MODE_CHAOS) ? CHAOS_HP : null;

        foreach ($players as $index => $player) {
            // bot_ready_at is reset to NULL so each bot re-arms its own random
            // "thinking" delay on the very first night (see processNightBots).
            // Settlement stats reset too, so a replayed room starts clean.
            $stmt = $pdo->prepare("UPDATE players SET role = ?, is_alive = 1, target_id = NULL, vote_id = NULL, bot_ready_at = NULL,
                                     hp = ?, max_hp = ?, heal_target = NULL, seer_hp = NULL, hp_delta = NULL,
                                     damage_done = 0, wolf_votes = 0, special_kills = 0 WHERE id = ?");
            $stmt->execute([$deck[$index], $startHp, $startHp, $player['id']]);
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
    // heal_target belongs to Chaos (the Doctor's blind heal), and hp_delta is
    // last night's reading — cleared here so a stale "you were wounded" line
    // never survives into the next night.
    $pdo->prepare("UPDATE players SET target_id = NULL, check_target = NULL, poison_target = NULL, poison_skip = 0,
                          doctor_choice = NULL, heal_target = NULL, hp_delta = NULL, asleep = 0 WHERE room_code = ?")
        ->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET night_step = 'actions', pending_victim = NULL, night_deadline = ? WHERE room_code = ?")
        ->execute([time() + NIGHT_SECONDS, $roomCode]);
}

// Has every night actor finished? Alive wolves must have locked a victim,
// an alive Seer must have divined, an alive Witch must have spent or passed
// her poison, and everyone with NO night action (villagers + the Doctor) must
// have tapped "sleep" (which also masks the sound of the kill tap on a call).
function nightActionsComplete(PDO $pdo, $roomCode, $mode = 'classic') {
    $s = $pdo->prepare("SELECT role, target_id, check_target, poison_target, poison_skip, poison_used, doctor_choice, asleep
                          FROM players WHERE room_code = ? AND is_alive = 1");
    $s->execute([$roomCode]);
    foreach ($s->fetchAll() as $p) {
        if ($p['role'] === 'Werewolf') {
            if ($p['target_id'] === null) return false;
        } elseif ($p['role'] === 'Seer') {
            if ($p['check_target'] === null) return false;
        } elseif ($p['role'] === 'Witch') {
            if (!(int)$p['poison_used'] && $p['poison_target'] === null && !(int)$p['poison_skip']) return false;
        } elseif ($p['role'] === 'Doctor' && $mode === 'chaos') {
            // Chaos: the Doctor takes a real action — a blind heal of one player.
            // Declining is allowed (doctor_choice = 0, no heal_target).
            if ($p['doctor_choice'] === null) return false;
        } else {
            // Villager / (classic) Doctor: must bunk down before the night resolves.
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
    $r = $pdo->prepare("SELECT status, night_step, night_deadline, mode FROM rooms WHERE room_code = ?");
    $r->execute([$roomCode]);
    $room = $r->fetch();
    if (!$room || $room['status'] !== 'night') return false;
    $mode = validMode($room['mode']);

    // ---- Doctor step: CLASSIC ONLY (the revive window) ----
    // Chaos deliberately has no such step: handing the Doctor tonight's victim
    // would tell them exactly who needed help, which this mode forbids.
    if ($room['night_step'] === 'doctor' && $mode !== MODE_CHAOS) {
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
    if (!nightActionsComplete($pdo, $roomCode, $mode) && !$timedOut) return false;

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

    // Chaos: there is no single victim and no Doctor window — every wolf's bite
    // is applied in finalizeNightChaos, which also keeps the wounded anonymous.
    if ($mode === MODE_CHAOS) {
        return finalizeNight($pdo, $roomCode);
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

    // Chaos resolves completely differently: bites WOUND instead of executing.
    $mRow = $pdo->prepare("SELECT mode FROM rooms WHERE room_code = ?");
    $mRow->execute([$roomCode]);
    if (validMode($mRow->fetchColumn()) === MODE_CHAOS) {
        return finalizeNightChaos($pdo, $roomCode);
    }

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

    // --- Settlement stat -----------------------------------------------------
    // Did the wolves' call kill a POWER ROLE? Only the werewolf victim counts
    // (the Witch's poison is not a wolf kill) and only when the Doctor didn't
    // save them. Every wolf who named the victim shares the credit for the call.
    $killCredit = false;
    if ($victimId && !$revived) {
        $vr = $pdo->prepare("SELECT role FROM players WHERE id = ? AND room_code = ?");
        $vr->execute([$victimId, $roomCode]);
        $killCredit = in_array((string)$vr->fetchColumn(), ['Seer', 'Witch', 'Doctor'], true);
    }

    foreach (array_keys($deaths) as $id) {
        $pdo->prepare("UPDATE players SET is_alive = 0 WHERE id = ? AND room_code = ?")->execute([$id, $roomCode]);
        if ($killCredit && (int)$id === (int)$victimId) {
            // target_id still holds tonight's wolf picks (resetNightState runs later).
            $pdo->prepare("UPDATE players SET special_kills = special_kills + 1
                            WHERE room_code = ? AND role = 'Werewolf' AND target_id = ?")
                ->execute([$roomCode, $victimId]);
        }
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

/* ================= CHAOS NIGHT NIGHT-RESOLUTION =================
   Nights WOUND instead of executing. Everyone's HP is hidden, so a non-lethal
   attack must stay completely invisible: the public narrative only ever names
   the DEAD. An attacked-but-surviving player learns only that they lost HP —
   never who hit them.

   Resolution order: all bites (stacking) + poison, then healing capped at max.
   Applying healing AFTER damage is what makes overhealing simply wasted. */
function finalizeNightChaos(PDO $pdo, $roomCode) {
    $now = time();

    $s = $pdo->prepare("SELECT id, nickname, role, is_alive, hp, target_id, heal_target, poison_target, poison_used, doctor_choice
                          FROM players WHERE room_code = ? ORDER BY id");
    $s->execute([$roomCode]);
    $all = $s->fetchAll();

    $hp = []; $alive = []; $name = [];
    foreach ($all as $p) {
        $id = (int)$p['id'];
        $hp[$id]    = ($p['hp'] === null) ? CHAOS_HP : (int)$p['hp'];
        $alive[$id] = ((int)$p['is_alive'] === 1);
        $name[$id]  = $p['nickname'];
    }

    $dmg = [];       // target id => total damage
    $heal = [];      // target id => total healing
    $wolfDmg = [];   // wolf id  => damage it dealt (settlement award)

    // 1) Every alive wolf bites its own target. Damage STACKS, so a pack that
    //    focuses one player can drop them in a single night.
    foreach ($all as $p) {
        $id = (int)$p['id'];
        if ($p['role'] !== 'Werewolf' || !$alive[$id]) continue;
        $t = (int)($p['target_id'] ?? 0);
        if ($t <= 0 || empty($alive[$t])) continue;
        $dmg[$t] = ($dmg[$t] ?? 0) + CHAOS_BITE;
        $wolfDmg[$id] = ($wolfDmg[$id] ?? 0) + CHAOS_BITE;
    }

    // 2) The Witch's one-shot poison — heavy damage, spent on use.
    foreach ($all as $p) {
        if ($p['role'] !== 'Witch') continue;
        if (!(int)$p['poison_used'] && (int)($p['poison_target'] ?? 0) > 0) {
            $t = (int)$p['poison_target'];
            if (!empty($alive[$t])) $dmg[$t] = ($dmg[$t] ?? 0) + CHAOS_POISON;
            $pdo->prepare("UPDATE players SET poison_used = 1 WHERE id = ?")->execute([(int)$p['id']]);
        }
    }

    // 3) The Doctor's blind heal. It lands whether or not it was needed, and the
    //    Doctor is NEVER told which — that uncertainty is the point of the role
    //    in this mode.
    foreach ($all as $p) {
        $id = (int)$p['id'];
        if ($p['role'] !== 'Doctor' || !$alive[$id]) continue;
        $t = (int)($p['heal_target'] ?? 0);
        if ($t > 0 && !empty($alive[$t])) $heal[$t] = ($heal[$t] ?? 0) + CHAOS_HEAL;
    }

    // 4) Apply. hp_delta is the ONLY thing the affected seat gets to see.
    $touched = array_values(array_unique(array_merge(array_keys($dmg), array_keys($heal))));
    $dead = [];
    foreach ($touched as $id) {
        $id = (int)$id;
        if (empty($alive[$id])) continue;
        $before = $hp[$id];
        $after  = $before - (int)($dmg[$id] ?? 0) + (int)($heal[$id] ?? 0);
        if ($after > CHAOS_HP) $after = CHAOS_HP;     // overheal is wasted
        if ($after < 0) $after = 0;
        $pdo->prepare("UPDATE players SET hp = ?, hp_delta = ? WHERE id = ?")
            ->execute([$after, $after - $before, $id]);
        if ($after <= 0) $dead[$id] = true;
    }

    foreach ($wolfDmg as $wid => $amount) {
        $pdo->prepare("UPDATE players SET damage_done = damage_done + ? WHERE id = ?")->execute([$amount, (int)$wid]);
    }

    // Anything untouched this night gets its stale reading cleared.
    $notTouched = $touched ? " AND id NOT IN (" . implode(',', array_map('intval', $touched)) . ")" : "";
    $pdo->prepare("UPDATE players SET hp_delta = NULL WHERE room_code = ? AND hp_delta IS NOT NULL$notTouched")
        ->execute([$roomCode]);

    foreach (array_keys($dead) as $id) {
        $pdo->prepare("UPDATE players SET is_alive = 0, hp = 0 WHERE id = ? AND room_code = ?")->execute([(int)$id, $roomCode]);
    }

    // Public narrative: only DEATHS are visible. A night where people were hurt
    // but nobody died reads exactly like a quiet night — that is the mode.
    if ($dead) {
        $names = [];
        foreach (array_keys($dead) as $id) $names[] = '**' . $name[$id] . '**';
        $event = (count($names) === 1)
            ? "During the night, {$names[0]} was found dead."
            : 'During the night, ' . implode(', ', $names) . ' were found dead.';
    } else {
        $event = 'The night passed quietly — nobody was found dead.';
    }

    // Clear per-night state and flip to day.
    $pdo->prepare("UPDATE players SET target_id = NULL, check_target = NULL, poison_target = NULL, poison_skip = 0,
                          doctor_choice = NULL, heal_target = NULL, asleep = 0, bot_ready_at = NULL WHERE room_code = ?")
        ->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'day', phase_started_at = ?, night_step = 'actions', pending_victim = NULL, night_deadline = 0, last_event = ? WHERE room_code = ?")
        ->execute([$now, $event, $roomCode]);
    return true;
}

// A vote/action target must exist, belong to THIS room, and still be alive.
// Stale clients are the real risk: a backgrounded tab can still be showing a
// roster from before somebody died, so its "vote for Bob" would otherwise count
// toward a corpse — which let an already-dead player be executed a second time
// and quietly wasted the village's whole day.
function validLiveTarget(PDO $pdo, $roomCode, $targetId) {
    $targetId = (int)$targetId;
    if ($targetId <= 0) return null;
    $s = $pdo->prepare("SELECT * FROM players WHERE id = ? AND room_code = ? AND is_alive = 1 LIMIT 1");
    $s->execute([$targetId, $roomCode]);
    $t = $s->fetch();
    return $t ?: null;
}

// Resolve the day: every alive player has voted OR skipped -> apply the lynch
// rules, wipe the votes, flip to night. Returns true if the phase advanced.
//
// House rules (user-specified):
//   * two or more players tied on the highest vote count -> nobody is executed
//   * the skip count beats the highest vote count        -> nobody is executed
function resolveDay(PDO $pdo, $roomCode) {
    $stmt = $pdo->prepare("SELECT id, vote_id, vote_skip, role FROM players WHERE room_code = ? AND is_alive = 1");
    $stmt->execute([$roomCode]);
    $living = $stmt->fetchAll();
    if (count($living) === 0) return false;

    $livingIds = [];
    foreach ($living as $p) $livingIds[(int)$p['id']] = true;

    $voteCounts = [];
    $skipCount = 0;
    foreach ($living as $p) {
        if ((int)$p['vote_skip']) { $skipCount++; continue; }
        if ($p['vote_id'] === null) return false;   // still waiting on somebody
        $tid = (int)$p['vote_id'];
        // A vote aimed at someone who is no longer alive is not a vote.
        if (!isset($livingIds[$tid])) continue;
        $voteCounts[$tid] = ($voteCounts[$tid] ?? 0) + 1;
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
        $pdo->prepare("UPDATE players SET is_alive = 0, hp = 0 WHERE id = ?")->execute([$lynchedId]);
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

    // --- Settlement stat -----------------------------------------------------
    // Who put their day vote ON a werewolf? Folded into the SAME statement that
    // clears the votes, so the extra stat costs no additional durable write.
    $roleById = [];
    foreach ($living as $p) $roleById[(int)$p['id']] = $p['role'];
    $hitIds = [];
    foreach ($living as $p) {
        $tid = (int)$p['vote_id'];
        if ($tid > 0 && isset($livingIds[$tid]) && ($roleById[$tid] ?? '') === 'Werewolf') {
            $hitIds[] = (int)$p['id'];
        }
    }
    $wolfVoteExpr = $hitIds
        ? 'wolf_votes + (CASE WHEN id IN (' . implode(',', $hitIds) . ') THEN 1 ELSE 0 END)'
        : 'wolf_votes';

    $pdo->prepare("UPDATE players SET vote_id = NULL, vote_skip = 0, wolf_votes = $wolfVoteExpr WHERE room_code = ?")->execute([$roomCode]);
    // New night: reset bot "thinking" timers so kills land at varying times.
    $pdo->prepare("UPDATE players SET bot_ready_at = NULL WHERE room_code = ? AND is_bot = 1")->execute([$roomCode]);
    $pdo->prepare("UPDATE rooms SET status = 'night', phase_started_at = ?, last_event = ?, last_vote = ? WHERE room_code = ?")
        ->execute([time(), $event, $result, $roomCode]);
    // Arm the new night's skill state.
    resetNightState($pdo, $roomCode);
    return true;
}
