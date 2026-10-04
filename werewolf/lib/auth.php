<?php
/* werewolf / lib/auth.php — accounts, sessions, rank.
   Included by backend.php. Accounts are optional: guests keep playing exactly
   as before, they just never accumulate a win rate or a rank.

   Design notes specific to this box:
   - Sessions are DB-backed opaque tokens, NOT PHP native sessions. The poll
     long-polls (>1s) and file sessions lock, so native sessions would serialise
     a player's own requests.
   - Every DB write here costs ~270ms (InnoDB redo fsync on this NAS), so each
     user-facing operation is wrapped in ONE transaction = ONE commit: register
     writes user+session together, and the whole match award is a single commit.
   - Passwords use PASSWORD_DEFAULT (bcrypt). This PHP has no sodium extension,
     so Argon2id is not assumed to be available. */

const AUTH_COOKIE = 'wolf_auth';

function authCookieName() { return AUTH_COOKIE; }

function authHashToken($token) { return hash('sha256', $token); }

function authClientIp() {
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
}

function authSessionToken() {
    return (string)($_COOKIE[AUTH_COOKIE] ?? '');
}

// Cookie flags: HttpOnly (JS can't read it), Secure whenever we're on HTTPS,
// SameSite=Lax so cross-site POSTs can't ride the session.
function authSetCookie($token) {
    $secure = (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off')
           || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    if (PHP_VERSION_ID >= 70300) {
        setcookie(AUTH_COOKIE, $token, [
            'expires'  => time() + AUTH_SESSION_TTL,
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    } else {
        setcookie(AUTH_COOKIE, $token, time() + AUTH_SESSION_TTL, '/', '', $secure, true);
    }
}

function authClearCookie() {
    $secure = (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off');
    setcookie(AUTH_COOKIE, '', time() - 3600, '/', '', $secure, true);
}

// Resolve the signed-in user for this request (null for guests). Cached so the
// poll and the action handlers never hit the DB twice.
function authUser(PDO $pdo) {
    static $cached = false;
    static $user = null;
    if ($cached) return $user;
    $cached = true;

    $tok = authSessionToken();
    if ($tok === '') return $user = null;
    try {
        $s = $pdo->prepare("SELECT u.*, s.id AS session_id, s.expires_at
                              FROM auth_sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.revoked_at = 0 AND s.expires_at > ?
                             LIMIT 1");
        $s->execute([authHashToken($tok), time()]);
        $row = $s->fetch();
        $user = ($row && (int)$row['status'] === 1) ? $row : null;
    } catch (Exception $e) {
        $user = null;
    }
    return $user;
}

function authTier($rating) {
    if ($rating >= 1750) return 'Master';
    if ($rating >= 1600) return 'Diamond';
    if ($rating >= 1450) return 'Platinum';
    if ($rating >= 1300) return 'Gold';
    if ($rating >= 1150) return 'Silver';
    return 'Bronze';
}

// The shape the client sees. Never leaks the password hash.
function authUserPublic($u) {
    if (!$u) return null;
    $games = (int)$u['games'];
    $wins  = (int)$u['wins'];
    $rating = (int)$u['rating'];
    return [
        'id'        => (int)$u['id'],
        'name'      => $u['display_name'] !== null && $u['display_name'] !== '' ? $u['display_name'] : $u['username'],
        'username'  => $u['username'],
        'games'     => $games,
        'wins'      => $wins,
        'losses'    => max(0, $games - $wins),
        'rating'    => $rating,
        'peak'      => (int)$u['peak_rating'],
        'tier'      => authTier($rating),
        'win_rate'  => $games > 0 ? round($wins * 100 / $games, 1) : 0.0,
    ];
}

function authValidUsername($u) {
    return (bool)preg_match('/^[A-Za-z0-9_]{3,24}$/', $u);
}

function authRateLimited(PDO $pdo, $username, $ip) {
    try {
        $s = $pdo->prepare("SELECT COUNT(*) FROM auth_attempts
                             WHERE ok = 0 AND created_at > ? AND (username = ? OR ip = ?)");
        $s->execute([time() - AUTH_LOCK_SECONDS, $username, $ip]);
        return ((int)$s->fetchColumn()) >= AUTH_MAX_ATTEMPTS;
    } catch (Exception $e) {
        return false;
    }
}

function authLogAttempt(PDO $pdo, $username, $ok) {
    try {
        $pdo->prepare("INSERT INTO auth_attempts (username, ip, ok, created_at) VALUES (?, ?, ?, ?)")
            ->execute([$username, authClientIp(), $ok ? 1 : 0, time()]);
    } catch (Exception $e) {}
}

function authIssueSession(PDO $pdo, $userId) {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $pdo->prepare("INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)")
        ->execute([$userId, authHashToken($token), $now, $now + AUTH_SESSION_TTL, authClientIp()]);
    // Housekeeping: drop expired/revoked rows for this user (same commit).
    $pdo->prepare("DELETE FROM auth_sessions WHERE user_id = ? AND (expires_at < ? OR revoked_at > 0)")
        ->execute([$userId, $now]);
    return $token;
}

function authLogout(PDO $pdo) {
    $tok = authSessionToken();
    if ($tok !== '') {
        try {
            $pdo->prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?")
                ->execute([time(), authHashToken($tok)]);
        } catch (Exception $e) {}
    }
    authClearCookie();
}

// Register. One transaction -> one commit (user row + session row together).
function authRegister(PDO $pdo, $username, $password) {
    if (!authValidUsername($username)) {
        return [false, 'Username must be 3-24 characters: letters, numbers or underscore.'];
    }
    if (strlen($password) < 6) {
        return [false, 'Password must be at least 6 characters.'];
    }
    try {
        // The users.username index is case-insensitive (utf8mb4 CI collation),
        // so this check also catches "Alice" vs "alice".
        $chk = $pdo->prepare("SELECT id FROM users WHERE username = ?");
        $chk->execute([$username]);
        if ($chk->fetch()) return [false, 'That username is already taken.'];

        $now = time();
        $hash = password_hash($password, PASSWORD_DEFAULT);

        $pdo->beginTransaction();
        $pdo->prepare("INSERT INTO users (username, password_hash, created_at, last_login_at, rating, peak_rating)
                       VALUES (?, ?, ?, ?, ?, ?)")
            ->execute([$username, $hash, $now, $now, AUTH_RATING_START, AUTH_RATING_START]);
        $uid = (int)$pdo->lastInsertId();
        $token = authIssueSession($pdo, $uid);
        $pdo->commit();

        authSetCookie($token);
        authLogAttempt($pdo, $username, true);
        return [true, ['id' => $uid, 'token' => $token]];
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        return [false, 'Could not create the account. Please try again.'];
    }
}

function authLogin(PDO $pdo, $username, $password) {
    if ($username === '' || $password === '') return [false, 'Enter your username and password.'];
    if (authRateLimited($pdo, $username, authClientIp())) {
        return [false, 'Too many failed attempts. Try again in a few minutes.'];
    }
    $s = $pdo->prepare("SELECT * FROM users WHERE username = ?");
    $s->execute([$username]);
    $u = $s->fetch();
    if (!$u || !password_verify($password, $u['password_hash'])) {
        authLogAttempt($pdo, $username, false);
        return [false, 'Wrong username or password.'];
    }
    if ((int)$u['status'] !== 1) {
        authLogAttempt($pdo, $username, false);
        return [false, 'This account has been suspended.'];
    }
    // Re-hash if the algorithm/cost changed since the account was created.
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
        $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?")
            ->execute([password_hash($password, PASSWORD_DEFAULT), (int)$u['id']]);
    }
    try {
        $pdo->beginTransaction();
        $token = authIssueSession($pdo, (int)$u['id']);
        $pdo->prepare("UPDATE users SET last_login_at = ? WHERE id = ?")->execute([time(), (int)$u['id']]);
        $pdo->commit();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        return [false, 'Could not start a session. Please try again.'];
    }
    authSetCookie($token);
    authLogAttempt($pdo, $username, true);
    return [true, ['id' => (int)$u['id'], 'token' => $token]];
}

// A guest who signs in mid-game keeps their seat: attach the account to the
// player row they're already holding (only while the game is still running).
function authLinkSeat(PDO $pdo, $userId, $roomCode, $playerToken) {
    if (!$userId || $roomCode === '' || $playerToken === '') return false;
    try {
        $s = $pdo->prepare("UPDATE players SET user_id = ?
                             WHERE room_code = ? AND session_token = ? AND is_bot = 0 AND user_id IS NULL");
        $s->execute([$userId, $roomCode, $playerToken]);
        return $s->rowCount() > 0;
    } catch (Exception $e) {
        return false;
    }
}

// Award a finished match. Everything (ratings + per-seat deltas) happens in ONE
// transaction, which means ONE fsync (~270ms) instead of one per player.
function authAwardGame(PDO $pdo, $roomCode, $winner) {
    try {
        $s = $pdo->prepare("SELECT p.id AS player_id, p.user_id, p.role, u.rating
                              FROM players p JOIN users u ON u.id = p.user_id
                             WHERE p.room_code = ? AND p.user_id IS NOT NULL AND p.is_bot = 0");
        $s->execute([$roomCode]);
        $rows = $s->fetchAll();
        if (!$rows) return 0;

        $isWin = function ($role) use ($winner) {
            $wolf = ($role === 'Werewolf');
            return ($winner === 'werewolves') ? $wolf : !$wolf;
        };

        $sumWin = 0; $sumLose = 0; $nWin = 0; $nLose = 0;
        foreach ($rows as $r) {
            if ($isWin($r['role'])) { $sumWin += (int)$r['rating']; $nWin++; }
            else { $sumLose += (int)$r['rating']; $nLose++; }
        }
        $avgWin  = $nWin  ? $sumWin / $nWin   : AUTH_RATING_START;
        $avgLose = $nLose ? $sumLose / $nLose : AUTH_RATING_START;

        $pdo->beginTransaction();
        foreach ($rows as $r) {
            $won = $isWin($r['role']);
            $my  = (int)$r['rating'];
            $opp = $won ? $avgLose : $avgWin;
            $expected = 1 / (1 + pow(10, ($opp - $my) / 400));
            $delta = (int)round(AUTH_K * (($won ? 1 : 0) - $expected));
            $new = max(100, $my + $delta);

            $pdo->prepare("UPDATE users SET games = games + 1, wins = wins + ?, rating = ?,
                                  peak_rating = GREATEST(peak_rating, ?) WHERE id = ?")
                ->execute([$won ? 1 : 0, $new, $new, (int)$r['user_id']]);
            $pdo->prepare("UPDATE players SET rating_delta = ?, user_won = ? WHERE id = ?")
                ->execute([$delta, $won ? 1 : 0, (int)$r['player_id']]);
        }
        $pdo->commit();
        return count($rows);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        return 0;
    }
}
