<?php
/**
 * StereoNET PULSE Retailer Tracking Pixel
 * ----------------------------------------
 * Drop this file at the EE web root as track-r.php so it's reachable as:
 *   https://www.stereonet.com/track-r.php          (page-view pixel)
 *   https://www.stereonet.com/track-r.php?click=1  (outbound click)
 *
 * Security model:
 *   - Always returns a 1x1 GIF to the browser (cannot be used for probing).
 *   - Token-authenticates server-to-server to PULSE (separate token from the
 *     EE bridge so a compromise of one doesn't reveal the other).
 *   - Connection is closed before forwarding so the browser never waits.
 *   - PULSE side also verifies the source IP is the EE host (defence in depth).
 *   - Debug log lives outside the web root so it isn't fetchable.
 */

declare(strict_types=1);

const PULSE_INGEST_URL   = 'https://dashboard.stereonet.com/api/retailers/ingest';
// Dedicated token for tracking. NOT the same as the EE bridge token. Rotate
// here AND PULSE_TRACK_TOKEN in the PULSE .env (or the default in retailers.ts).
const PULSE_TRACK_TOKEN  = 'sn-trk-9D2mQp4XzKt8Yr6Lv3Nw7Bf';

// 1x1 transparent GIF
$GIF = base64_decode('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==');

// Send the pixel FIRST so the browser doesn't wait on PULSE.
header('Content-Type: image/gif');
header('Cache-Control: no-store, no-cache, must-revalidate, private');
header('Pragma: no-cache');
header('Expires: 0');
header('X-Content-Type-Options: nosniff');
header('Content-Length: ' . strlen($GIF));
echo $GIF;

// Flush + close the connection so PULSE forwarding happens in background.
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} else {
    @ob_end_flush();
    @flush();
}

// Resolve real client IP (Cloudflare provides CF-Connecting-IP).
$ip = $_SERVER['HTTP_CF_CONNECTING_IP']
    ?? $_SERVER['HTTP_X_FORWARDED_FOR']
    ?? $_SERVER['REMOTE_ADDR']
    ?? '';
if (is_string($ip) && strpos($ip, ',') !== false) {
    $ip = trim(explode(',', $ip)[0]);
}
$country = $_SERVER['HTTP_CF_IPCOUNTRY'] ?? '';
$ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 500);
$referer = substr((string)($_SERVER['HTTP_REFERER'] ?? ''), 0, 500);

$payload = [
    'kind'      => isset($_GET['click']) ? 'click' : 'hit',
    'entry_id'  => (int)($_GET['id'] ?? 0),
    'url'       => isset($_GET['u']) ? substr((string)$_GET['u'], 0, 1000) : '',
    'recipient' => isset($_GET['r']) ? substr((string)$_GET['r'], 0, 100) : '',
    'ip'        => $ip,
    'country'   => $country,
    'ua'        => $ua,
    'referrer'  => $referer,
];

if (!$payload['entry_id']) return;

// Skip if the referrer isn't from stereonet.com (rejects most bots that
// crawl track-r.php directly from URLs they find in logs/source).
if ($referer && stripos($referer, 'stereonet.com') === false) {
    return;
}

// Forward to PULSE. Short timeouts so we never hang the PHP worker.
if (!function_exists('curl_init')) {
    error_log('[track-r] curl extension not available');
    return;
}
$ch = curl_init(PULSE_INGEST_URL);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode($payload),
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'X-Pulse-Track-Token: ' . PULSE_TRACK_TOKEN,
        'User-Agent: PULSE-track-forwarder/1.0',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 5,
    CURLOPT_CONNECTTIMEOUT => 3,
    CURLOPT_SSL_VERIFYPEER => true,
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

// Persist a tiny debug log OUTSIDE the public web root so it isn't fetchable.
// Falls back to error_log() if the parent directory isn't writable.
$logDir = dirname(__DIR__) . '/pulse-logs';
if (!is_dir($logDir)) @mkdir($logDir, 0750, true);
$logPath = $logDir . '/track-r.log';
$line = sprintf("[%s] entry=%d kind=%s status=%d err=%s\n",
    date('c'), $payload['entry_id'], $payload['kind'], $status, $err ?: '-');
if (!@file_put_contents($logPath, $line, FILE_APPEND)) {
    error_log('[track-r] ' . trim($line));
} elseif (@filesize($logPath) > 200000) {
    // Trim to last 100KB
    $tail = substr((string)@file_get_contents($logPath), -100000);
    @file_put_contents($logPath, $tail);
}
