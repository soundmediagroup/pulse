<?php
/**
 * StereoNET EE -> PULSE Bridge
 * --------------------------------
 * Drop this file at the EE web root (e.g. /home/stereoglobal/public_html/ee-bridge.php).
 *
 * Security model:
 *   - All requests must be POST with Content-Type: application/json.
 *   - Shared token in X-Pulse-Token header, compared with hash_equals().
 *   - No arbitrary SQL: only the queries in $QUERIES can run.
 *   - Identifiers (table names, column names) are NEVER taken from request input.
 *     Where IDs derived from input form part of a table/column name, the input
 *     is cast to (int) first and matched against whitelisted values.
 *   - DB error messages are not returned to the caller in production
 *     (set DEBUG_DETAIL=true temporarily if you need to diagnose).
 *   - Auth failures sleep for 1 second to slow brute-force attempts.
 *   - Writes are restricted to channel 19 (Retailers) and a per-field
 *     value whitelist.
 *   - Sets X-Robots-Tag and disables caching on every response.
 *
 * To rotate the token: change PULSE_BRIDGE_TOKEN here AND EE_BRIDGE_TOKEN
 * in the PULSE .env (or the default in server/retailers.ts), then redeploy PULSE.
 */

declare(strict_types=1);

// --- CONFIG ----------------------------------------------------------------
const PULSE_BRIDGE_TOKEN = 'sn-ee-br1dge-9F2kRm8WqLpYx4vN7Bc3Hd';

const DB_HOST = 'localhost';
const DB_NAME = 'stereoglobal_ee24';
const DB_USER = 'stereoglobal_ee24';
const DB_PASS = 'tAb8O-d9Y1?o';

const RETAILER_CHANNEL_ID = 19;

// Toggle to true ONLY when actively debugging; false in production.
const DEBUG_DETAIL = false;

// --- BASE HEADERS ----------------------------------------------------------
header('Content-Type: application/json; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store, no-cache, must-revalidate, private');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

// --- METHOD GUARD ----------------------------------------------------------
// Reject anything other than POST. Prevents accidental GET requests where the
// token might end up in server logs or referrers.
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed']);
    exit;
}

// --- AUTH ------------------------------------------------------------------
$got = $_SERVER['HTTP_X_PULSE_TOKEN'] ?? '';
if (!is_string($got) || strlen($got) !== strlen(PULSE_BRIDGE_TOKEN) || !hash_equals(PULSE_BRIDGE_TOKEN, $got)) {
    // Slow down brute force probes.
    sleep(1);
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'forbidden']);
    exit;
}

// --- BODY ------------------------------------------------------------------
$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'empty_body']);
    exit;
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_json']);
    exit;
}
$query  = (string)($body['query'] ?? '');
$params = is_array($body['params'] ?? null) ? $body['params'] : [];

// --- DB --------------------------------------------------------------------
try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
} catch (Throwable $e) {
    error_log('[pulse-bridge] db_connect_failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'db_connect_failed']);
    exit;
}

// --- HELPERS ---------------------------------------------------------------
/**
 * Returns the list of integer field IDs that have a dedicated
 * exp_channel_data_field_<id> table. Cached per request.
 */
$_perFieldTables = null;
function perFieldTables(PDO $pdo): array {
    global $_perFieldTables;
    if ($_perFieldTables !== null) return $_perFieldTables;
    $out = [];
    try {
        $rows = $pdo->query("SHOW TABLES LIKE 'exp_channel_data_field_%'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($rows as $t) {
            if (preg_match('/^exp_channel_data_field_(\d+)$/', $t, $m)) $out[] = (int)$m[1];
        }
    } catch (Throwable $e) { /* ignore */ }
    return $_perFieldTables = $out;
}

/**
 * Builds the join + select fragments for per-field tables. Field IDs are
 * sourced from perFieldTables() — never from request input — so direct
 * interpolation into SQL is safe (they are integers from SHOW TABLES).
 */
function perFieldFragments(PDO $pdo): array {
    $joins = ''; $selects = '';
    foreach (perFieldTables($pdo) as $fid) {
        $fid = (int)$fid; // belt and braces
        $joins   .= " LEFT JOIN exp_channel_data_field_$fid f$fid ON f$fid.entry_id = ct.entry_id";
        $selects .= ", f{$fid}.field_id_{$fid} AS field_id_{$fid}";
    }
    return [$joins, $selects];
}

// --- WHITELISTED QUERIES ---------------------------------------------------
$QUERIES = [
    // Sanity check: confirm bridge alive + Retailers channel reachable.
    'ping' => function (PDO $pdo) {
        $ver = $pdo->query('SELECT VERSION() AS v')->fetch();
        $ch = $pdo->prepare('SELECT channel_id, channel_name, channel_title FROM exp_channels WHERE channel_id = ?');
        $ch->execute([RETAILER_CHANNEL_ID]);
        $count = $pdo->prepare('SELECT COUNT(*) AS n FROM exp_channel_titles WHERE channel_id = ?');
        $count->execute([RETAILER_CHANNEL_ID]);
        return [
            'version' => $ver['v'],
            'channel' => $ch->fetch(),
            'entry_count' => (int)$count->fetch()['n'],
        ];
    },

    // List all custom fields available for the Retailers channel.
    'fields' => function (PDO $pdo) {
        $rows = []; $sources = [];
        // EE 5/6/7 — many-to-many: exp_channels_channel_fields
        try {
            $q = $pdo->prepare('SELECT f.field_id, f.field_name, f.field_label, f.field_type
                                  FROM exp_channel_fields f
                                  JOIN exp_channels_channel_fields m ON m.field_id = f.field_id
                                 WHERE m.channel_id = ?
                              ORDER BY f.field_id');
            $q->execute([RETAILER_CHANNEL_ID]);
            $r = $q->fetchAll();
            if (count($r)) { $sources[] = 'm2m'; foreach ($r as $x) $rows[] = $x; }
        } catch (Throwable $e) { /* */ }
        // EE 5/6/7 — many-to-many via field group
        try {
            $q = $pdo->prepare('SELECT DISTINCT f.field_id, f.field_name, f.field_label, f.field_type
                                  FROM exp_channel_fields f
                                  JOIN exp_channel_field_groups_fields gf ON gf.field_id = f.field_id
                                  JOIN exp_channels_channel_field_groups cg ON cg.group_id = gf.group_id
                                 WHERE cg.channel_id = ?
                              ORDER BY f.field_id');
            $q->execute([RETAILER_CHANNEL_ID]);
            $r = $q->fetchAll();
            if (count($r)) { $sources[] = 'm2m_group'; foreach ($r as $x) $rows[] = $x; }
        } catch (Throwable $e) { /* */ }
        // EE 2/3/4 legacy
        try {
            $q = $pdo->prepare('SELECT f.field_id, f.field_name, f.field_label, f.field_type
                                  FROM exp_channel_fields f
                                  JOIN exp_channels c ON c.field_group = f.group_id
                                 WHERE c.channel_id = ?
                              ORDER BY f.field_id');
            $q->execute([RETAILER_CHANNEL_ID]);
            $r = $q->fetchAll();
            if (count($r)) { $sources[] = 'legacy_group'; foreach ($r as $x) $rows[] = $x; }
        } catch (Throwable $e) { /* */ }
        // Fallback
        if (count($rows) === 0) {
            try {
                $q = $pdo->query('SELECT field_id, field_name, field_label, field_type FROM exp_channel_fields ORDER BY field_id');
                $rows = $q->fetchAll();
                $sources[] = 'all_fields_fallback';
            } catch (Throwable $e) { /* */ }
        }
        // Dedupe
        $seen = []; $out = [];
        foreach ($rows as $r) {
            if (isset($seen[$r['field_id']])) continue;
            $seen[$r['field_id']] = true;
            $out[] = $r;
        }
        return ['sources' => $sources, 'fields' => $out];
    },

    // List retailers + custom-field values (joined across per-field tables).
    'list_retailers' => function (PDO $pdo, array $p) {
        $limit  = max(1, min(2000, (int)($p['limit'] ?? 500)));
        $offset = max(0, (int)($p['offset'] ?? 0));
        $search = trim((string)($p['search'] ?? ''));
        [$joins, $selects] = perFieldFragments($pdo);

        $where = 'ct.channel_id = ?';
        $args  = [RETAILER_CHANNEL_ID];
        if ($search !== '') { $where .= ' AND ct.title LIKE ?'; $args[] = '%' . $search . '%'; }

        // $joins, $selects, $limit, $offset are all derived from server-side
        // values or strictly cast integers — never raw request input.
        $sql = "SELECT ct.entry_id, ct.title, ct.url_title, ct.status, ct.entry_date, ct.edit_date,
                       ct.view_count_one,
                       ct.author_id, m.username AS author_username, m.screen_name AS author_screen,
                       cd.* $selects
                  FROM exp_channel_titles ct
                  LEFT JOIN exp_channel_data cd ON cd.entry_id = ct.entry_id
                  LEFT JOIN exp_members m ON m.member_id = ct.author_id
                  $joins
                 WHERE $where
                 ORDER BY ct.title ASC
                 LIMIT $limit OFFSET $offset";
        $st = $pdo->prepare($sql);
        $st->execute($args);
        $rows = $st->fetchAll();

        $total = $pdo->prepare('SELECT COUNT(*) AS n FROM exp_channel_titles WHERE channel_id = ?' . ($search !== '' ? ' AND title LIKE ?' : ''));
        $total->execute($search !== '' ? [RETAILER_CHANNEL_ID, '%' . $search . '%'] : [RETAILER_CHANNEL_ID]);

        return ['rows' => $rows, 'total' => (int)$total->fetch()['n'], 'limit' => $limit, 'offset' => $offset];
    },

    // Single retailer detail.
    'get_retailer' => function (PDO $pdo, array $p) {
        $id = (int)($p['entry_id'] ?? 0);
        if (!$id) return ['error' => 'entry_id required'];
        [$joins, $selects] = perFieldFragments($pdo);

        $st = $pdo->prepare("SELECT ct.*, cd.*, m.username AS author_username, m.screen_name AS author_screen $selects
                               FROM exp_channel_titles ct
                               LEFT JOIN exp_channel_data cd ON cd.entry_id = ct.entry_id
                               LEFT JOIN exp_members m ON m.member_id = ct.author_id
                               $joins
                              WHERE ct.entry_id = ? AND ct.channel_id = ?");
        $st->execute([$id, RETAILER_CHANNEL_ID]);
        $row = $st->fetch();
        if (!$row) return ['error' => 'not_found'];

        $cats = $pdo->prepare('SELECT c.cat_id, c.cat_name, c.cat_url_title
                                 FROM exp_categories c
                                 JOIN exp_category_posts cp ON cp.cat_id = c.cat_id
                                WHERE cp.entry_id = ?');
        $cats->execute([$id]);
        $row['_categories'] = $cats->fetchAll();
        return $row;
    },

    // Distinct status values used on this channel.
    'list_statuses' => function (PDO $pdo) {
        $st = $pdo->prepare('SELECT DISTINCT status FROM exp_channel_titles WHERE channel_id = ?');
        $st->execute([RETAILER_CHANNEL_ID]);
        return $st->fetchAll();
    },

    // ---- WRITES (scoped, whitelisted) ------------------------------------
    // Set a per-field-table value. Strictly limited to a whitelist of
    // {field_id => allowed-values} on channel 19.
    'set_field_value' => function (PDO $pdo, array $p) {
        $entryId = (int)($p['entry_id'] ?? 0);
        $fieldId = (int)($p['field_id'] ?? 0);
        $value   = (string)($p['value'] ?? '');
        if (!$entryId || !$fieldId) return ['error' => 'entry_id + field_id required'];

        $WRITE_WHITELIST = [
            133 => ['', 'yes'], // Premium checkbox
        ];
        if (!isset($WRITE_WHITELIST[$fieldId])) {
            return ['error' => 'field_id not writable', 'allowed' => array_keys($WRITE_WHITELIST)];
        }
        if (!in_array($value, $WRITE_WHITELIST[$fieldId], true)) {
            return ['error' => 'value not permitted for this field', 'allowed' => $WRITE_WHITELIST[$fieldId]];
        }

        // Confirm the entry belongs to the retailer channel.
        $own = $pdo->prepare('SELECT entry_id FROM exp_channel_titles WHERE entry_id = ? AND channel_id = ?');
        $own->execute([$entryId, RETAILER_CHANNEL_ID]);
        if (!$own->fetch()) return ['error' => 'entry not in retailer channel'];

        // Confirm the per-field table actually exists (defence in depth so we
        // never CREATE a table by accident or write to a non-EE table).
        if (!in_array($fieldId, perFieldTables($pdo), true)) {
            return ['error' => 'field has no per-field-table'];
        }

        // $fieldId is whitelisted above AND validated against the actual
        // per-field-table list, so direct interpolation into table/column
        // names is safe.
        $table = "exp_channel_data_field_$fieldId";
        $col   = "field_id_$fieldId";

        try {
            $exists = $pdo->prepare("SELECT id FROM $table WHERE entry_id = ?");
            $exists->execute([$entryId]);
            $existing = $exists->fetch();
            if ($existing) {
                $st = $pdo->prepare("UPDATE $table SET $col = ? WHERE entry_id = ?");
                $st->execute([$value, $entryId]);
                $action = 'updated';
            } else {
                $st = $pdo->prepare("INSERT INTO $table (entry_id, $col) VALUES (?, ?)");
                $st->execute([$entryId, $value]);
                $action = 'inserted';
            }
        } catch (Throwable $e) {
            error_log('[pulse-bridge] set_field_value: ' . $e->getMessage());
            return ['error' => 'write_failed'];
        }

        // Bump edit_date so EE template caches refresh.
        try {
            $pdo->prepare('UPDATE exp_channel_titles SET edit_date = ? WHERE entry_id = ?')
                ->execute([date('YmdHis'), $entryId]);
        } catch (Throwable $e) { /* non-fatal */ }

        return ['ok' => true, 'action' => $action, 'entry_id' => $entryId, 'field_id' => $fieldId, 'value' => $value];
    },

    // Update a whitelisted column on exp_channel_titles (e.g. status).
    'set_entry_field' => function (PDO $pdo, array $p) {
        $entryId = (int)($p['entry_id'] ?? 0);
        $column  = (string)($p['column'] ?? '');
        $value   = (string)($p['value'] ?? '');
        if (!$entryId || !$column) return ['error' => 'entry_id + column required'];

        $ALLOWED_COLUMNS = ['status'];
        if (!in_array($column, $ALLOWED_COLUMNS, true)) {
            return ['error' => 'column not writable', 'allowed' => $ALLOWED_COLUMNS];
        }
        $ALLOWED_VALUES = [
            'status' => ['open', 'closed', 'exported-open', 'exported-closed', 'draft', 'submitted'],
        ];
        if (isset($ALLOWED_VALUES[$column]) && !in_array($value, $ALLOWED_VALUES[$column], true)) {
            return ['error' => 'value not permitted for this column', 'allowed' => $ALLOWED_VALUES[$column]];
        }

        $own = $pdo->prepare('SELECT entry_id FROM exp_channel_titles WHERE entry_id = ? AND channel_id = ?');
        $own->execute([$entryId, RETAILER_CHANNEL_ID]);
        if (!$own->fetch()) return ['error' => 'entry not in retailer channel'];

        try {
            // $column is whitelisted above; safe to interpolate.
            $st = $pdo->prepare("UPDATE exp_channel_titles SET $column = ?, edit_date = ? WHERE entry_id = ?");
            $st->execute([$value, date('YmdHis'), $entryId]);
        } catch (Throwable $e) {
            error_log('[pulse-bridge] set_entry_field: ' . $e->getMessage());
            return ['error' => 'write_failed'];
        }
        return ['ok' => true, 'entry_id' => $entryId, 'column' => $column, 'value' => $value];
    },
];

// --- DISPATCH --------------------------------------------------------------
if (!isset($QUERIES[$query])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'unknown_query', 'available' => array_keys($QUERIES)]);
    exit;
}

try {
    $result = $QUERIES[$query]($pdo, $params);
    echo json_encode(['ok' => true, 'query' => $query, 'result' => $result], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    error_log('[pulse-bridge] query_failed (' . $query . '): ' . $e->getMessage());
    http_response_code(500);
    $out = ['ok' => false, 'error' => 'query_failed'];
    if (DEBUG_DETAIL) $out['detail'] = $e->getMessage();
    echo json_encode($out);
}
