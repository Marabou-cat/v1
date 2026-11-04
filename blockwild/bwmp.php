<?php
/**
 * BLOCKWILD 公网联机桥。
 *
 * 为什么需要它：联机守护进程监听的是 NAS 本机的 127.0.0.1:9203，公网域名（https）访问不到这个端口，
 * 而给 nginx 加反向代理需要 root 权限。这个文件放在 docroot 里，用 PHP 把请求转发回环到守护进程，
 * 于是「公网 HTTPS → Apache/PHP → 127.0.0.1:9203」这条路不需要改任何服务器配置。
 *
 * 代价：WebSocket 走不了（PHP 是短连接），客户端在这种模式下自动切成 ~8Hz 的 sync 轮询。
 * 局域网直连 9203 时仍然是 10Hz 的 WebSocket。
 *
 * 安全：只转发固定的 /api 路径，不暴露守护进程的其它东西；请求体大小限制 64KB。
 */
header('Content-Type: text/plain; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: *');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 65536) { echo json_encode(['ok' => false, 'e' => 'bad_body']); exit; }
// 只放行 JSON 对象，别让它当任意请求的跳板
$probe = json_decode($raw, true);
if (!is_array($probe) || !isset($probe['a'])) { echo json_encode(['ok' => false, 'e' => 'bad_json']); exit; }

/* ────────────────────────────────────────────────────────────────────────────
 * 自愈：守护进程不在就现场把它拉起来
 *
 * 用户看到的「daemon 找不到 / daemon_unreachable」几乎都是同一件事：9203 上没有进程在听
 * （进程崩了、NAS 重启了、或者上一次是用默认端口 9103 起的）。以前只能等有人手工 ssh 上去重启，
 * 整站联机就一直挂着。这里借 PHP 之手做保活（零 root）：
 *   · Apache 的 PHP 以 http 身份运行，可以起自己的子进程；
 *   · 绝对路径（PHP 的 PATH 经常是空的，写 `node` 会 not found）；
 *   · flock + 15 秒节流：并发请求只让一个去拉，别把首访拖死；
 *   · 拉起后最多等 1.5 秒，让「这次」请求就能成功（客户端不用等下一轮）。
 * 前置条件（已在 NAS 上配好）：BW_DATA 目录对 http 可写（ACL user:http=rwx）。
 * ──────────────────────────────────────────────────────────────────────────── */
function bw_daemon_alive($port = 9203) {
    $fp = @fsockopen('127.0.0.1', $port, $en, $es, 0.15);
    if ($fp) { @fclose($fp); return true; }
    return false;
}
function bw_spawn_daemon() {
    /* ⚠ 末尾那圈 `( … ) > /dev/null 2>&1` 不能省：不加的时候 PHP 的 exec() 会一直等
       「继承了自己 stdout 管道的子进程组」关掉 → 实测第一条请求被拖到 10 秒超时（客户端就是白屏/超时）。
       把整个子 shell 的输出丢掉，exec 才能立刻返回。 */
    $cmd = '( cd /volume1/schoolexam_web/v1/blockwild/server'
         . ' && BW_PORT=9203 BW_DATA=/volume1/schoolexam_web/bw_mp_data'
         . ' setsid /volume1/@appstore/Node.js_v20/usr/local/bin/node bw_daemon.js'
         . ' >> /tmp/bw_daemon_http.out 2>&1 < /dev/null & ) > /dev/null 2>&1';
    if (function_exists('exec')) { @exec($cmd); return true; }
    if (function_exists('shell_exec')) { @shell_exec($cmd); return true; }
    return false;                                  // disable_functions 把两个都阉了 → 只能返回失败
}
function bw_ensure_daemon() {
    if (bw_daemon_alive()) return true;
    $lk = @fopen('/tmp/bw_mp_spawn.lock', 'c');
    $mine = ($lk && @flock($lk, LOCK_EX | LOCK_NB));
    if ($mine) {
        $stamp = '/tmp/bw_mp_spawn.stamp';
        $last = @filemtime($stamp);
        if (!$last || time() - $last > 15) {       // 15 秒节流：崩了就崩了，别每个请求都 fork
            @touch($stamp);
            bw_spawn_daemon();
            for ($i = 0; $i < 30; $i++) {          // 最多 1.5 秒
                usleep(50000);
                if (bw_daemon_alive()) break;
            }
        }
        @flock($lk, LOCK_UN);
    }
    if ($lk) @fclose($lk);
    return bw_daemon_alive();
}

$ctx = stream_context_create([
    'http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: text/plain\r\nContent-Length: " . strlen($raw) . "\r\n",
        'content'       => $raw,
        'timeout'       => 5,
        'ignore_errors' => true,
    ],
]);

bw_ensure_daemon();                                // 不在就先拉起来（在的话只花一次 socket 探测）
$out = @file_get_contents('http://127.0.0.1:9203/api', false, $ctx);
if ($out === false && bw_ensure_daemon()) {        // 二次机会：刚好在上面的间隙里掉了
    $out = @file_get_contents('http://127.0.0.1:9203/api', false, $ctx);
}
if ($out === false) {
    echo json_encode(['ok' => false, 'e' => 'daemon_unreachable']);
    exit;
}
echo $out;
