<?php
/* =============================================================================
 *  超级乱斗 · 联机透传代理 (PHP → 本机守护进程)
 *  为什么要它：Apache 没有加载 proxy_wstunnel，且没有 root 改配置；
 *  用 PHP 把 HTTP 请求转到 127.0.0.1:9001 就能复用现有 HTTPS，无需新端口/新证书。
 *  用法：POST 本文件（body 就是守护进程的 action JSON）；
 *        GET  ?p=health  或  ?p=results&count=20  转发只读接口。
 * ========================================================================== */
$PORT = 9001;
$HOST = '127.0.0.1';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: content-type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { echo '{"ok":true}'; exit; }

function proxy($method, $path, $body = null, $port = 9001, $host = '127.0.0.1') {
    $fp = @fsockopen($host, $port, $errno, $errstr, 2.5);
    if (!$fp) return null;
    stream_set_timeout($fp, 4);
    $len = $body === null ? 0 : strlen($body);
    $req = "$method $path HTTP/1.1\r\nHost: $host:$port\r\nAccept: application/json\r\n";
    if ($len) $req .= "Content-Type: application/json\r\nContent-Length: $len\r\n";
    $req .= "Connection: close\r\n\r\n";
    if ($len) $req .= $body;
    fwrite($fp, $req);
    $resp = stream_get_contents($fp);
    fclose($fp);
    if ($resp === false) return null;
    $p = strpos($resp, "\r\n\r\n");
    return $p === false ? $resp : substr($resp, $p + 4);
}

/* 只读接口转发 */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $p = isset($_GET['p']) ? $_GET['p'] : 'health';
    if (!preg_match('/^[a-z]+$/', $p)) { http_response_code(400); echo '{"ok":false,"e":"bad_path"}'; exit; }
    $q = '';
    if ($p === 'results') $q = '?count=' . max(1, min(50, intval(isset($_GET['count']) ? $_GET['count'] : 20)));
    $out = proxy('GET', '/' . $p . $q);
    if ($out === null) { http_response_code(503); echo '{"ok":false,"e":"daemon_down"}'; exit; }
    echo $out; exit;
}

/* 业务 action 转发 */
$body = file_get_contents('php://input');
if ($body === false || $body === '') $body = '{}';
if (strlen($body) > 65536) { http_response_code(413); echo '{"ok":false,"e":"too_big"}'; exit; }
$out = proxy('POST', '/api', $body);
if ($out === null) { http_response_code(503); echo '{"ok":false,"e":"daemon_down"}'; exit; }
echo $out;
