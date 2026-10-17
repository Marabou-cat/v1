<?php
/* =============================================================================
 *  超级乱斗 · 战绩榜（班级排行）
 *  数据来自守护进程的战绩落盘（results.jsonl），经本机 127.0.0.1:9001 读取。
 *  纯自持：无外部字体/JS/CSS，页面自渲染。
 * ========================================================================== */
$PORT = 9001; $HOST = '127.0.0.1';

function daemon_get($path, $port = 9001, $host = '127.0.0.1') {
    $fp = @fsockopen($host, $port, $errno, $errstr, 2.5);
    if (!$fp) return null;
    stream_set_timeout($fp, 5);
    fwrite($fp, "GET $path HTTP/1.1\r\nHost: $host:$port\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    $r = stream_get_contents($fp); fclose($fp);
    if ($r === false) return null;
    $p = strpos($r, "\r\n\r\n");
    return $p === false ? $r : substr($r, $p + 4);
}

$raw = daemon_get('/results?count=300');
$data = $raw ? json_decode($raw, true) : null;
$list = ($data && !empty($data['list'])) ? $data['list'] : [];
$down = ($raw === null);

/* ---- 聚合：按昵称累计 ---- */
$players = [];
$matches = 0;
foreach ($list as $rec) {
    $rank = isset($rec['result']['rank']) ? $rec['result']['rank'] : null;
    if (!$rank) continue;
    $matches++;
    foreach ($rank as $i => $p) {
        $name = isset($p['name']) && $p['name'] !== '' ? $p['name'] : ('座位' . ($p['seat'] + 1));
        if (empty($p['ai']) === false) continue;                 // AI 不参与排行
        if (!isset($players[$name])) $players[$name] = ['name'=>$name,'m'=>0,'win'=>0,'kos'=>0,'ko'=>0,'best'=>99,'dmg'=>0];
        $pl = &$players[$name];
        $pl['m']++;
        if ($i === 0) $pl['win']++;
        $pl['kos'] += isset($p['kos']) ? intval($p['kos']) : 0;
        $pl['ko']  += isset($p['deaths']) ? intval($p['deaths']) : 0;
        $pl['dmg'] += isset($p['dmg']) ? intval($p['dmg']) : 0;
        if ($i + 1 < $pl['best']) $pl['best'] = $i + 1;
        unset($pl);
    }
}
$rows = array_values($players);
usort($rows, function ($a, $b) {
    if ($b['win'] !== $a['win']) return $b['win'] - $a['win'];
    if ($b['kos'] !== $a['kos']) return $b['kos'] - $a['kos'];
    return $a['ko'] - $b['ko'];
});
$CH = ['sparky'=>'火花','rocky'=>'岩霸','zephyr'=>'碧风','cobalt'=>'铁甲',
       'mage'=>'法师','warrior'=>'战士','archer'=>'弓箭手','knight'=>'骑士'];
function esc($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function medal($i) { return $i === 0 ? '🥇' : ($i === 1 ? '🥈' : ($i === 2 ? '🥉' : ($i + 1))); }
?>
<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>超级乱斗 · 战绩榜</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{min-height:100vh;background:radial-gradient(120% 80% at 50% -10%,#2b3f7a 0%,#151a33 45%,#0b0e1c 100%);
  color:#eaf0ff;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:18px 14px 40px}
 .wrap{max-width:820px;margin:0 auto}
 h1{font-size:26px;font-weight:900;letter-spacing:2px;text-align:center;
  background:linear-gradient(180deg,#fff6c9,#ffc93c 55%,#e08b00);-webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;filter:drop-shadow(0 3px 10px rgba(255,180,0,.35))}
 .sub{text-align:center;opacity:.6;font-size:12.5px;margin:6px 0 16px;letter-spacing:1px}
 .bar{display:flex;gap:10px;justify-content:center;margin-bottom:16px;flex-wrap:wrap}
 .bar a,.bar span{font-size:12.5px;font-weight:800;padding:8px 16px;border-radius:999px;text-decoration:none;
  background:linear-gradient(180deg,#5ec8ff,#2f7de0);color:#fff;box-shadow:0 3px 0 #1c4f96}
 .bar span{background:rgba(255,255,255,.08);box-shadow:none;color:#bcd0ff}
 table{width:100%;border-collapse:collapse;font-size:13px;background:rgba(255,255,255,.04);
  border:1.5px solid rgba(120,220,255,.18);border-radius:12px;overflow:hidden}
 th,td{padding:9px 8px;text-align:center}
 th{font-size:11px;letter-spacing:1px;opacity:.72;background:rgba(0,0,0,.28);font-weight:700}
 tbody tr{border-top:1px solid rgba(255,255,255,.07)}
 tbody tr:nth-child(1){background:linear-gradient(90deg,rgba(255,200,60,.16),transparent)}
 tbody tr:nth-child(2){background:linear-gradient(90deg,rgba(200,215,255,.10),transparent)}
 tbody tr:nth-child(3){background:linear-gradient(90deg,rgba(210,150,90,.10),transparent)}
 td.nm{text-align:left;font-weight:800}
 td b{color:#ffd166}
 .dim{opacity:.5;font-size:11.5px}
 .empty{text-align:center;padding:34px 12px;opacity:.68;font-size:13.5px;line-height:1.9}
 .empty code{background:rgba(0,0,0,.35);padding:2px 7px;border-radius:6px;font-size:12px}
 .rec{margin-top:20px;background:rgba(255,255,255,.035);border:1.5px solid rgba(255,255,255,.10);
  border-radius:12px;padding:12px 13px}
 .rec h2{font-size:13px;letter-spacing:1px;opacity:.75;margin-bottom:9px;font-weight:800}
 .mr{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);font-size:12.5px}
 .mr:first-of-type{border-top:none}
 .mr i{font-style:normal;opacity:.45;font-size:11px;min-width:74px}
 .mr u{text-decoration:none;padding:1px 7px;border-radius:999px;font-size:10.5px;background:rgba(94,200,255,.18)}
 .mr u.w{background:#ffd166;color:#3a2a00;font-weight:800}
 .warn{text-align:center;font-size:12px;padding:9px;border-radius:9px;background:rgba(255,90,90,.14);
  border:1px solid rgba(255,90,90,.3);margin-bottom:14px}
</style></head><body><div class="wrap">
<h1>超级乱斗 · 战绩榜</h1>
<div class="sub">SUPER BRAWL ARENA · LEADERBOARD</div>
<?php if ($down): ?>
  <div class="warn">⚠ 联机服务暂时不可用（守护进程未响应），战绩无法读取</div>
<?php endif; ?>
<div class="bar">
  <a href="../smash.html">← 返回游戏</a>
  <span>累计对局 <?= (int)$matches ?> 场 · 上榜玩家 <?= count($rows) ?> 人</span>
</div>
<?php if (!$rows): ?>
  <div class="empty">
    还没有战绩记录。<br>
    打开 <a href="../smash.html" style="color:#5ec8ff">游戏</a>，在「联机对战」里创建房间，<br>
    打完一局（分出胜负或时间到）后就会出现在这里。<br>
    <span class="dim">房间码是 5 位，发给同学即可一起玩</span>
  </div>
<?php else: ?>
  <table>
    <thead><tr><th>名次</th><th style="text-align:left">玩家</th><th>场次</th><th>胜</th><th>击倒</th><th>被击倒</th><th>最好名次</th></tr></thead>
    <tbody>
    <?php foreach ($rows as $i => $p): ?>
      <tr>
        <td><?= medal($i) ?></td>
        <td class="nm"><?= esc($p['name']) ?></td>
        <td><?= (int)$p['m'] ?></td>
        <td><b><?= (int)$p['win'] ?></b></td>
        <td><?= (int)$p['kos'] ?></td>
        <td><?= (int)$p['ko'] ?></td>
        <td><?= (int)$p['best'] ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
<?php endif; ?>
<?php if ($list): ?>
  <div class="rec">
    <h2>最近对局</h2>
    <?php foreach (array_slice($list, 0, 15) as $rec):
      if (empty($rec['result']['rank'])) continue;
      $t = isset($rec['t']) ? date('n/j H:i', (int)($rec['t'] / 1000)) : '';
      $rk = $rec['result']['rank'];
      $win = isset($rk[0]) ? $rk[0] : null; ?>
      <div class="mr">
        <i><?= esc($t) ?></i>
        <u class="w"><?= esc(isset($win['name']) ? $win['name'] : '—') ?> 胜</u>
        <?php foreach (array_slice($rk, 1) as $p): ?>
          <u><?= esc(isset($p['name']) ? $p['name'] : '') ?>·<?= esc($CH[isset($p['char']) ? $p['char'] : ''] ?? '') ?>×<?= (int)(isset($p['stocks']) ? $p['stocks'] : 0) ?></u>
        <?php endforeach; ?>
        <span class="dim" style="margin-left:auto"><?= isset($rec['result']['frames']) ? (int)($rec['result']['frames'] / 60) : 0 ?>s</span>
      </div>
    <?php endforeach; ?>
  </div>
<?php endif; ?>
</div></body></html>
