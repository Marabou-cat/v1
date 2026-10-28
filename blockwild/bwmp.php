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

$ctx = stream_context_create([
    'http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: text/plain\r\nContent-Length: " . strlen($raw) . "\r\n",
        'content'       => $raw,
        'timeout'       => 5,
        'ignore_errors' => true,
    ],
]);
$out = @file_get_contents('http://127.0.0.1:9203/api', false, $ctx);
if ($out === false) {
    echo json_encode(['ok' => false, 'e' => 'daemon_unreachable']);
    exit;
}
echo $out;
