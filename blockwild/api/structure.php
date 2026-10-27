<?php
/* 方块荒野 · 创作者结构上传接口
   POST  { token, name, data:{ size:[w,h,d], blocks:[[x,y,z,id,m],...] } }
   GET   列出已上传结构
   数据落在 docroot 之外（不可被 https 直接下载） */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$DIR   = '/volume1/schoolexam_web/sbgames_data/structures';
$TOKEN = 'bw-creator-2026-v1';
$MAX   = 6 * 1024 * 1024;

if (!is_dir($DIR)) { @mkdir($DIR, 0775, true); }

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') { http_response_code(400); echo json_encode(array('ok'=>false,'err'=>'empty')); exit; }
    if (strlen($raw) > $MAX)          { http_response_code(413); echo json_encode(array('ok'=>false,'err'=>'too_large','bytes'=>strlen($raw))); exit; }
    $j = json_decode($raw, true);
    if (!is_array($j))                { http_response_code(400); echo json_encode(array('ok'=>false,'err'=>'bad_json')); exit; }
    if (!isset($j['token']) || $j['token'] !== $TOKEN) { http_response_code(403); echo json_encode(array('ok'=>false,'err'=>'bad_token')); exit; }

    $name = isset($j['name']) ? preg_replace('/[^A-Za-z0-9_-]/', '', (string)$j['name']) : 'struct';
    if ($name === '') { $name = 'struct'; }
    if (strlen($name) > 40) { $name = substr($name, 0, 40); }
    $blocks = isset($j['data']['blocks']) && is_array($j['data']['blocks']) ? $j['data']['blocks'] : array();
    $size   = isset($j['data']['size']) ? $j['data']['size'] : null;

    $file = $name . '_' . date('Ymd_His') . '.json';
    $path = $DIR . '/' . $file;
    $save = array('name'=>$name, 'uploaded'=>date('c'), 'size'=>$size, 'blocks'=>$blocks);
    $w = file_put_contents($path, json_encode($save, JSON_UNESCAPED_UNICODE));
    if ($w === false) { http_response_code(500); echo json_encode(array('ok'=>false,'err'=>'write_failed','dir'=>$DIR)); exit; }
    @chmod($path, 0644);
    echo json_encode(array('ok'=>true, 'file'=>$file, 'bytes'=>$w, 'blocks'=>count($blocks), 'size'=>$size));
    exit;
}

/* GET：列表 / 读取单个 */
if (isset($_GET['get'])) {
    $f = preg_replace('/[^A-Za-z0-9_.-]/', '', (string)$_GET['get']);
    $p = $DIR . '/' . $f;
    if (!is_file($p)) { http_response_code(404); echo json_encode(array('ok'=>false,'err'=>'not_found')); exit; }
    echo file_get_contents($p);
    exit;
}
$out = array();
foreach (glob($DIR . '/*.json') ?: array() as $f) {
    $out[] = array('file'=>basename($f), 'bytes'=>filesize($f), 'mtime'=>date('c', filemtime($f)));
}
usort($out, function($a, $b){ return strcmp($b['mtime'], $a['mtime']); });
echo json_encode(array('ok'=>true, 'count'=>count($out), 'files'=>$out));
