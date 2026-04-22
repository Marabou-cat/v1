<?php
// Ensure errors don't break the HTML output
error_reporting(0);

$url = $_GET['url'] ?? '';

if (empty($url)) {
    die("No URL provided.");
}

// Make sure the URL starts with http:// or https://
if (!preg_match("~^(?:f|ht)tps?://~i", $url)) {
    $url = "https://" . $url;
}

// Parse the URL to help fix broken image/css links later
$parsed_url = parse_url($url);
$base_url = $parsed_url['scheme'] . '://' . $parsed_url['host'];
if (isset($parsed_url['port'])) {
    $base_url .= ':' . $parsed_url['port'];
}

// Initialize cURL (The engine that fetches the website)
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // Ignore SSL errors for better compatibility
curl_setopt($ch, CURLOPT_USERAGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
curl_setopt($ch, CURLOPT_TIMEOUT, 15);

$response = curl_exec($ch);
$content_type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

// Set the correct content type so the browser knows if it's an image, CSS, or HTML
header("Content-Type: " . $content_type);

// IMPORTANT: A basic attempt to fix broken links.
// It rewrites relative links (like /images/logo.png) to absolute links (https://site.com/images/logo.png)
// so the page doesn't look completely broken.
if (strpos($content_type, 'text/html') !== false && $response !== false) {
    // Fix src="/..." and href="/..."
    $response = preg_replace('/(src|href)=["\']\/(?![\/])([^"\']+)["\']/i', '$1="' . $base_url . '/$2"', $response);
    
    // Fix src="//..." and href="//..." (Protocol relative links)
    $response = preg_replace('/(src|href)=["\']\/\/([^"\']+)["\']/i', '$1="' . $parsed_url['scheme'] . '://$2"', $response);
}

// Spit the website out to the user!
echo $response;
?>
