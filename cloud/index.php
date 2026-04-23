<?php
session_start();

// 1. Read database credentials from ../config.ini
$configFile = '../config.ini';

if (!file_exists($configFile)) {
    die("<div style='color: #ff4444; padding: 20px; text-align: center; font-family: monospace; background: #111;'>
            [SYSTEM ERROR] CONFIG.INI NOT FOUND.
         </div>");
}

$lines = file($configFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

if (count($lines) < 2) {
    die("<div style='color: #ff4444; padding: 20px; text-align: center; font-family: monospace; background: #111;'>
            [SYSTEM ERROR] INVALID CREDENTIAL FORMAT.
         </div>");
}

$db_user = trim($lines[0]);
$db_pass = trim($lines[1]);
$db_name = 'schoolexams';
$db_host = 'localhost';

// 2. Connect to the database
try {
    $pdo = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
} catch (\PDOException $e) {
    die("<div style='color: #ff4444; padding: 20px; text-align: center; font-family: monospace; background: #111;'>
            [CONNECTION REFUSED] DATABASE OFFLINE.
         </div>");
}

$message = '';

// 3. Handle Form Submissions
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';
    $username = $_POST['username'] ?? '';
    $password = $_POST['password'] ?? ''; 

    if ($action === 'register') {
        $stmt = $pdo->prepare("INSERT INTO login (username, password) VALUES (?, ?)");
        try {
            $stmt->execute([$username, $password]);
            $message = "<div class='msg success'>User registered in mainframe. You may now authenticate.</div>";
        } catch (PDOException $e) {
            $message = "<div class='msg error'>Error: ID already exists in database.</div>";
        }
    } 
    elseif ($action === 'login') {
        $stmt = $pdo->prepare("SELECT * FROM login WHERE username = ? AND password = ?");
        $stmt->execute([$username, $password]);
        $userData = $stmt->fetch();

        if ($userData) {
            $_SESSION['logged_in'] = true;
            $_SESSION['username'] = $username;
        } else {
            $message = "<div class='msg error'>ACCESS DENIED: Invalid credentials.</div>";
        }
    }
}

// 4. Handle Logout
if (isset($_GET['logout'])) {
    session_destroy();
    header("Location: index.php");
    exit;
}
?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SchoolExams | Secure Gateway</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background-color: #0a0a0c; 
            background-image: radial-gradient(circle at 50% 0%, #1a1a24 0%, #0a0a0c 70%);
            color: #fff;
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            margin: 0; 
        }
        .login-wrapper {
            background: rgba(20, 20, 25, 0.9);
            border: 1px solid #333;
            border-top: 3px solid #00ffcc;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.8), 0 0 20px rgba(0, 255, 204, 0.1);
            width: 100%;
            max-width: 380px;
            text-align: center;
        }
        h2 {
            margin-top: 0;
            color: #ffffff;
            font-size: 24px;
            letter-spacing: 1px;
            margin-bottom: 30px;
        }
        h2 span { color: #00ffcc; }
        
        .input-group { margin-bottom: 20px; text-align: left; }
        label { display: block; font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 5px; font-weight: bold; }
        
        input { 
            width: 100%; 
            padding: 12px; 
            background: #111;
            border: 1px solid #444; 
            border-radius: 4px; 
            color: #fff;
            box-sizing: border-box; 
            font-size: 14px;
            transition: 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #00ffcc;
            box-shadow: 0 0 10px rgba(0, 255, 204, 0.2);
        }

        button { 
            width: 100%; 
            padding: 14px; 
            background: #00ffcc; 
            color: #000; 
            border: none; 
            border-radius: 4px; 
            cursor: pointer; 
            font-weight: 900; 
            text-transform: uppercase;
            letter-spacing: 1px;
            transition: 0.2s;
        }
        button:hover { background: #00e6b8; transform: translateY(-1px); }
        
        .btn-secondary { 
            background: transparent; 
            color: #aaa; 
            border: 1px solid #444; 
            margin-top: 10px;
        }
        .btn-secondary:hover { background: #222; color: #fff; }

        .msg { padding: 10px; border-radius: 4px; margin-bottom: 20px; font-size: 14px; font-weight: bold; }
        .success { background: rgba(0, 255, 0, 0.1); color: #00ffcc; border: 1px solid #00ffcc; }
        .error { background: rgba(255, 0, 0, 0.1); color: #ff4444; border: 1px solid #ff4444; }

        .logout-btn { display: inline-block; margin-top: 20px; color: #ff4444; text-decoration: none; font-weight: bold; padding: 10px 20px; border: 1px solid #ff4444; border-radius: 4px; }
        .logout-btn:hover { background: #ff4444; color: #000; }
        
        hr { border: 0; border-top: 1px solid #333; margin: 30px 0; }
    </style>
</head>
<body>

<div class="login-wrapper">
    <?php if (isset($_SESSION['logged_in']) && $_SESSION['logged_in']): ?>
        
        <h2>System <span>Bypassed</span></h2>
        <div style="font-size: 40px; margin-bottom: 20px;">🔓</div>
        <p>Welcome to the Skiss, <strong><?= htmlspecialchars($_SESSION['username']) ?></strong>.</p>
        <p style="color: #888; font-size: 13px;">Authentication successful. Plaintext verification complete.</p>
        <a href="?logout=1" class="logout-btn">TERMINATE SESSION</a>

    <?php else: ?>

        <h2>SchoolExams <span>Gateway</span></h2>
        
        <?= $message ?>

        <form method="POST">
            <input type="hidden" name="action" value="login">
            <div class="input-group">
                <label>Operator ID</label>
                <input type="text" name="username" required>
            </div>
            <div class="input-group">
                <label>Passcode</label>
                <input type="password" name="password" required>
            </div>
            <button type="submit">Initialize Link</button>
        </form>

        <hr>

        <form method="POST">
            <input type="hidden" name="action" value="register">
            <div class="input-group" style="margin-bottom: 10px;">
                <input type="text" name="username" placeholder="New Operator ID" required>
            </div>
            <div class="input-group">
                <input type="password" name="password" placeholder="New Passcode" required>
            </div>
            <button type="submit" class="btn-secondary">Request Access</button>
        </form>

    <?php endif; ?>
</div>

</body>
</html>
