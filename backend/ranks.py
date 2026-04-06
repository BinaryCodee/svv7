from __future__ import annotations
"""
StreamVault Backend — ranks.py
VIP rank system: privileges enforcement, screen tracking, priority queue.
All enforcement is server-side.
"""
import threading, time, queue
from backend.utils import (
    get_user_by_id, save_user, logger, CFG,
    rank_allows_1080p, rank_allows_downloads,
    rank_max_screens, rank_no_ads, rank_priority, get_rank_info, RANKS
)

VALID_RANKS = list(RANKS.keys())  # ["Basic", "Medium", "Premium"]

# ── Screen-count tracker (thread-safe) ─────────────────────────────
_screen_lock = threading.Lock()
_active_screens: dict[str, int] = {}   # uid → count
_screen_sessions: dict[str, set] = {}  # uid → {session_ids}


def open_screen(uid: str, session_key: str) -> dict:
    """
    Called when a user opens a player.
    Returns {"allowed": bool, "reason": str, "current": int, "max": int}
    """
    user = get_user_by_id(uid)
    if not user:
        return {"allowed": False, "reason": "User not found"}

    rank = user.get("rank", "Basic")
    max_sc = rank_max_screens(rank)

    with _screen_lock:
        if uid not in _screen_sessions:
            _screen_sessions[uid] = set()
        current = len(_screen_sessions[uid])
        if current >= max_sc:
            return {"allowed": False, "reason": f"Max {max_sc} screens for {rank}", "current": current, "max": max_sc}
        _screen_sessions[uid].add(session_key)
        current = len(_screen_sessions[uid])
        # Persist to DB
        user["active_screens"] = current
        save_user(user)
    return {"allowed": True, "current": current, "max": max_sc}


def close_screen(uid: str, session_key: str) -> None:
    user = get_user_by_id(uid)
    with _screen_lock:
        if uid in _screen_sessions:
            _screen_sessions[uid].discard(session_key)
            count = len(_screen_sessions[uid])
        else:
            count = 0
    if user:
        user["active_screens"] = count
        save_user(user)


def get_active_screens(uid: str) -> int:
    with _screen_lock:
        return len(_screen_sessions.get(uid, set()))


# ── Priority queue for player requests ─────────────────────────────
class _PriorityRequest:
    def __init__(self, uid: str, rank: str, payload: dict):
        self.uid = uid
        self.rank = rank
        self.priority = rank_priority(rank)   # 1=Premium, 2=Medium, 3=Basic
        self.payload = payload
        self.ts = time.time()
        self.result: dict | None = None
        self._event = threading.Event()

    def __lt__(self, other):
        # Lower number = higher priority
        return (self.priority, self.ts) < (other.priority, other.ts)

_pq: list[_PriorityRequest] = []
_pq_lock = threading.Lock()


def enqueue_player_request(uid: str, rank: str, payload: dict) -> _PriorityRequest:
    req = _PriorityRequest(uid, rank, payload)
    with _pq_lock:
        _pq.append(req)
        _pq.sort()  # priority sort
    return req


def dequeue_player_request() -> _PriorityRequest | None:
    with _pq_lock:
        if _pq:
            return _pq.pop(0)
    return None


# ── Rank-based player URL builder ───────────────────────────────────
def build_player_url(user: dict, media_type: str, tmdb_id: int,
                     season: int = None, episode: int = None,
                     lang: str = "it") -> dict:
    """
    Returns the vixsrc.to embed URL based on user's rank.
    Appends ad-block, quality, and lang params based on rank.
    """
    rank = user.get("rank", "Basic")
    base = CFG["vixsrc"]["base_url"]
    no_ads = rank_no_ads(rank)
    hd = rank_allows_1080p(rank)

    params = [f"autoplay=true", f"lang={lang}"]
    if no_ads:
        params.append("no_ads=1")
    if hd:
        params.append("quality=1080")

    qs = "&".join(params)

    if media_type == "tv" and season and episode:
        path = f"/tv/{tmdb_id}/{season}/{episode}"
    else:
        path = f"/movie/{tmdb_id}"

    url = f"{base}{path}?{qs}"
    return {
        "url": url,
        "rank": rank,
        "no_ads": no_ads,
        "hd_1080p": hd,
        "downloads": rank_allows_downloads(rank),
        "priority": rank_priority(rank)
    }


# ── Download access check ───────────────────────────────────────────
def check_download_access(user: dict) -> dict:
    rank = user.get("rank", "Basic")
    allowed = rank_allows_downloads(rank)
    return {
        "allowed": allowed,
        "rank": rank,
        "reason": None if allowed else f"Downloads not available for {rank} rank"
    }


# ── 1080p access check ──────────────────────────────────────────────
def check_1080p_access(user: dict) -> dict:
    rank = user.get("rank", "Basic")
    allowed = rank_allows_1080p(rank)
    return {
        "allowed": allowed,
        "rank": rank,
        "reason": None if allowed else f"1080p not available for {rank} rank"
    }


# ── Rank change (admin only) ────────────────────────────────────────
def set_user_rank(uid: str, new_rank: str, admin_user: dict) -> dict:
    if not admin_user.get("is_admin"):
        return {"ok": False, "error": "Forbidden"}
    if new_rank not in VALID_RANKS:
        return {"ok": False, "error": f"Invalid rank. Choose: {', '.join(VALID_RANKS)}"}
    user = get_user_by_id(uid)
    if not user:
        return {"ok": False, "error": "User not found"}
    old = user.get("rank", "Basic")
    user["rank"] = new_rank
    save_user(user)
    logger.info(f"[RANK] {uid} rank changed {old} → {new_rank} by {admin_user['username']}")
    return {"ok": True, "uid": uid, "rank": new_rank}


# ── Full rank info for API ──────────────────────────────────────────
def get_all_ranks_info() -> list:
    return [
        {"name": name, **info}
        for name, info in RANKS.items()
    ]
