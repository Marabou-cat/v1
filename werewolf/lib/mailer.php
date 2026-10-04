<?php
/* werewolf / lib/mailer.php — minimal dependency-free SMTP sender.

   Why hand-rolled: this box has no sendmail binary and /etc/ssmtp/ssmtp.conf is
   empty (so PHP's mail() cannot deliver), and we have no root to fix either.
   PHP *can* open a TLS socket though, so we speak SMTP directly — no system MTA,
   no root, no Composer.

   Credentials live in ../mail.ini (next to config.ini, git-ignored), NOT in git:
       smtp_host = smtp.gmail.com
       smtp_port = 465
       smtp_user = you@example.com
       smtp_pass = 16-char app password
       from      = you@example.com
       from_name = Werewolf

   Verified working against smtp.gmail.com on both 465 (implicit TLS) and 587
   (STARTTLS); we use 465. */

function mailConfig($reload = false) {
    static $cfg = null;
    if ($cfg !== null && !$reload) return $cfg;
    $cfg = [];
    $path = __DIR__ . '/../../mail.ini';
    if (is_readable($path)) {
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || $line[0] === ';') continue;
            $pos = strpos($line, '=');
            if ($pos === false) continue;
            $cfg[trim(substr($line, 0, $pos))] = trim(substr($line, $pos + 1));
        }
    }
    return $cfg;
}

function mailHeaderSafe($s) {
    return trim(str_replace(["\r", "\n"], ' ', (string)$s));
}

function smtpRead($fp, &$err) {
    $out = ''; $n = 0;
    while ($n++ < 80) {
        $line = @fgets($fp, 2048);
        if ($line === false) { $err = 'connection closed by server'; return $out; }
        $out .= $line;
        // "250-x" continues, "250 x" ends the reply.
        if (isset($line[3]) && $line[3] === ' ') break;
    }
    return $out;
}

function smtpStep($fp, $send, $expect, &$err) {
    if ($send !== null) @fwrite($fp, $send . "\r\n");
    $resp = smtpRead($fp, $err);
    if ($err !== '') return false;
    if (substr(ltrim($resp), 0, 3) !== $expect) {
        $err = 'expected ' . $expect . ', server said: ' . trim($resp);
        return false;
    }
    return true;
}

// Returns true on acceptance. $err carries the server's own reason on failure.
function smtpSendMail($toEmail, $subject, $bodyText, &$err = '') {
    $err = '';
    $c = mailConfig();
    $host = $c['smtp_host'] ?? 'smtp.gmail.com';
    $port = (int)($c['smtp_port'] ?? 465);
    $user = $c['smtp_user'] ?? '';
    $pass = $c['smtp_pass'] ?? '';
    $from = $c['from'] ?? $user;
    $fromName = $c['from_name'] ?? 'Werewolf';

    if ($user === '' || $pass === '') { $err = 'mail.ini is missing smtp_user/smtp_pass'; return false; }

    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $fp = @stream_socket_client("ssl://$host:$port", $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) { $err = "connect failed: $errstr ($errno)"; return false; }
    stream_set_timeout($fp, 20);

    $hostname = preg_replace('/[^A-Za-z0-9\.\-]/', '', (string)($_SERVER['SERVER_NAME'] ?? 'schoolexams.net')) ?: 'schoolexams.net';

    $ok = smtpStep($fp, null, '220', $err)                       // banner
       && smtpStep($fp, 'EHLO ' . $hostname, '250', $err)
       && smtpStep($fp, 'AUTH LOGIN', '334', $err)
       && smtpStep($fp, base64_encode($user), '334', $err)
       && smtpStep($fp, base64_encode($pass), '235', $err)
       && smtpStep($fp, "MAIL FROM:<$from>", '250', $err)
       && smtpStep($fp, "RCPT TO:<$toEmail>", '250', $err)
       && smtpStep($fp, 'DATA', '354', $err);

    if ($ok) {
        $domain = strstr($from, '@') ?: '@schoolexams.net';
        $headers =
              'From: ' . mailHeaderSafe($fromName) . " <$from>\r\n"
            . "To: <$toEmail>\r\n"
            . 'Subject: ' . mailHeaderSafe($subject) . "\r\n"
            . "MIME-Version: 1.0\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\n"
            . "Content-Transfer-Encoding: 8bit\r\n"
            . 'Date: ' . date('r') . "\r\n"
            . 'Message-ID: <' . bin2hex(random_bytes(8)) . $domain . ">\r\n"
            . "Auto-Submitted: auto-generated\r\n";
        // Dot-stuffing: a line consisting of "." would otherwise end the DATA.
        $body = str_replace("\n.", "\n..", str_replace("\r\n", "\n", $bodyText));
        @fwrite($fp, $headers . "\r\n" . $body . "\r\n.\r\n");
        $ok = smtpStep($fp, null, '250', $err);
    }

    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);
    return $ok;
}
