<?php
////////////////////// STREAMVAULT — se_player.php v6.0 ////////////////////
// Fallback PHP player: tenta uembed.xyz (primary) poi superembed/multiembed
// Passa sempre la lingua richiesta al player.
//////////////////////////////////////////////////////////////////////////

// Parametri
$video_id = isset($_GET['video_id']) ? trim($_GET['video_id']) : '';
$is_tmdb  = isset($_GET['tmdb'])     ? intval($_GET['tmdb'])   : 1;
$season   = 0;
$episode  = 0;
$lang     = isset($_GET['lang']) ? strtolower(trim($_GET['lang'])) : 'it';
$type     = isset($_GET['type']) ? strtolower(trim($_GET['type'])) : 'movie'; // 'movie' or 'tv'

if (isset($_GET['season']))       $season  = intval($_GET['season']);
elseif (isset($_GET['s']))        $season  = intval($_GET['s']);
if (isset($_GET['episode']))      $episode = intval($_GET['episode']);
elseif (isset($_GET['e']))        $episode = intval($_GET['e']);

if (empty($video_id)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Missing video_id']);
    exit;
}

// Build uembed.xyz URL (primary - has dub + subtitles for IT/EU)
if ($type === 'tv' && $season > 0) {
    $primary_url = "https://uembed.xyz/embed/tv?tmdb={$video_id}&season={$season}&episode={$episode}&lang={$lang}";
} else {
    $primary_url = "https://uembed.xyz/embed/movie?tmdb={$video_id}&lang={$lang}";
}

// Redirect to uembed primary
header("Location: $primary_url");
exit;
?>
