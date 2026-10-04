<?php
/* werewolf / lib/auth-mail.php — passwordless email-code sign in.

   There is NO password anywhere in the system. A 6-digit code emailed to the
   address is the only credential. Register and login are deliberately the SAME
   flow: the first successful verification creates the account, later ones sign
   in. That also makes the endpoint enumeration-proof — we never look the address
   up when sending, we just send.

   Only the SHA-256 of the code is stored. */

const CODE_TTL             = 600;   // 10 minutes
const CODE_MAX_ATTEMPTS    = 5;
const CODE_RESEND_COOLDOWN = 60;    // seconds between sends to the same address
const CODE_MAX_PER_HOUR    = 5;     // per email address
const CODE_MAX_PER_IP_HOUR = 15;    // per client IP

function authNormEmail($e) {
    return strtolower(trim((string)$e));
}

function authValidEmail($e) {
    return strlen((string)$e) <= 190 && filter_var($e, FILTER_VALIDATE_EMAIL) !== false;
}

// 0 = allowed, >0 = seconds of cooldown left, -1 = hourly cap reached.
function authSendAllowed(PDO $pdo, $email, $ip) {
    $now = time();
    try {
        $s = $pdo->prepare("SELECT created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1");
        $s->execute([$email]);
        $last = $s->fetchColumn();
        if ($last !== false && $last !== null && ($now - (int)$last) < CODE_RESEND_COOLDOWN) {
            return CODE_RESEND_COOLDOWN - ($now - (int)$last);
        }
        $s = $pdo->prepare("SELECT COUNT(*) FROM email_sends WHERE email = ? AND created_at > ?");
        $s->execute([$email, $now - 3600]);
        if ((int)$s->fetchColumn() >= CODE_MAX_PER_HOUR) return -1;

        if ($ip !== '') {
            $s = $pdo->prepare("SELECT COUNT(*) FROM email_sends WHERE ip = ? AND created_at > ?");
            $s->execute([$ip, $now - 3600]);
            if ((int)$s->fetchColumn() >= CODE_MAX_PER_IP_HOUR) return -1;
        }
    } catch (Exception $e) { /* fail open: never lock users out on a query error */ }
    return 0;
}

// Mint a code, store only its hash, mail it. One transaction = one fsync.
function authIssueLoginCode(PDO $pdo, $email, &$err = '') {
    $now  = time();
    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    try {
        $pdo->beginTransaction();
        // retire any code still outstanding for this address
        $pdo->prepare("UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at = 0")
            ->execute([$now, $email]);
        $pdo->prepare("INSERT INTO email_codes (email, code_hash, purpose, created_at, expires_at)
                       VALUES (?, ?, 'login', ?, ?)")
            ->execute([$email, hash('sha256', $code), $now, $now + CODE_TTL]);
        $pdo->commit();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $err = 'Could not create a code.';
        return false;
    }

    $body = "Your Werewolf sign-in code\r\n\r\n"
          . "        $code\r\n\r\n"
          . "It expires in 10 minutes and can only be used once.\r\n"
          . "If you did not ask for this, you can safely ignore this email.\r\n";

    $mailErr = '';
    $ok = smtpSendMail($email, 'Your Werewolf sign-in code', $body, $mailErr);
    if (!$ok) $err = $mailErr;

    try {
        $pdo->prepare("INSERT INTO email_sends (email, ip, ok, created_at) VALUES (?, ?, ?, ?)")
            ->execute([$email, authClientIp(), $ok ? 1 : 0, $now]);
    } catch (Exception $e) {}
    return $ok;
}

// Correct code -> create-or-login, issue a session. Returns
// ['user'=>row, 'is_new'=>bool] or null with $err set.
function authVerifyLoginCode(PDO $pdo, $email, $code, &$err = '') {
    $now = time();
    $s = $pdo->prepare("SELECT id, code_hash, attempts FROM email_codes
                         WHERE email = ? AND used_at = 0 AND expires_at > ?
                         ORDER BY id DESC LIMIT 1");
    $s->execute([$email, $now]);
    $row = $s->fetch();
    if (!$row) { $err = 'That code has expired — request a new one.'; return null; }
    if ((int)$row['attempts'] >= CODE_MAX_ATTEMPTS) {
        $err = 'Too many wrong tries — request a new code.';
        return null;
    }
    if (!hash_equals((string)$row['code_hash'], hash('sha256', trim((string)$code)))) {
        try {
            $pdo->prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?")->execute([(int)$row['id']]);
        } catch (Exception $e) {}
        $err = 'That code is not correct.';
        return null;
    }

    try {
        $pdo->beginTransaction();
        // single use
        $pdo->prepare("UPDATE email_codes SET used_at = ? WHERE id = ?")->execute([$now, (int)$row['id']]);

        $s = $pdo->prepare("SELECT * FROM users WHERE email = ? LIMIT 1");
        $s->execute([$email]);
        $u = $s->fetch();

        if ($u) {
            if ((int)$u['status'] !== 1) {
                $pdo->rollBack();
                $err = 'This account has been suspended.';
                return null;
            }
            $pdo->prepare("UPDATE users SET last_login_at = ?, email_verified_at = GREATEST(email_verified_at, ?) WHERE id = ?")
                ->execute([$now, $now, (int)$u['id']]);
            $uid = (int)$u['id'];
            $isNew = false;
        } else {
            // Register == login: first verified code creates the account.
            $local = strstr($email, '@', true);
            $name = mb_substr(($local === false ? $email : $local), 0, 24);
            $pdo->prepare("INSERT INTO users (email, email_verified_at, display_name, created_at, last_login_at, rating, peak_rating)
                           VALUES (?, ?, ?, ?, ?, ?, ?)")
                ->execute([$email, $now, $name, $now, $now, AUTH_RATING_START, AUTH_RATING_START]);
            $uid = (int)$pdo->lastInsertId();
            $isNew = true;
        }

        $token = authIssueSession($pdo, $uid);
        $pdo->commit();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $err = 'Could not sign you in. Please try again.';
        return null;
    }

    authSetCookie($token);
    $s = $pdo->prepare("SELECT * FROM users WHERE id = ?");
    $s->execute([$uid]);
    return ['user' => $s->fetch(), 'is_new' => $isNew];
}
