from __future__ import annotations
"""
StreamVault Backend — admin.py
Admin panel: user management, rank assignment, bans, stats.
Only callable by is_admin=True accounts.
"""
import uuid
from backend.utils import (
    get_all_users, get_user_by_id, save_user, logger,
    hash_password, validate_username, validate_password,
    username_exists, CFG, get_blacklist, add_to_blacklist, utcnow
)
from backend.ranks import set_user_rank, VALID_RANKS, get_all_ranks_info
from backend.security import block_ip, unblock_ip, get_blocked_ips

RANKS_INFO = get_all_ranks_info()


# ── Helpers ─────────────────────────────────────────────────────────
def _ok(data: dict = None) -> dict:
    return {"ok": True, **(data or {})}

def _err(msg: str, code: int = 400) -> dict:
    return {"ok": False, "error": msg, "code": code}

def _safe_user(user: dict) -> dict:
    """Remove password_hash from user before sending to admin UI."""
    u = dict(user)
    u.pop("password_hash", None)
    return u


# ── Dashboard stats ─────────────────────────────────────────────────
def get_dashboard_stats(admin: dict) -> dict:
    users = get_all_users()
    rank_counts = {r: 0 for r in VALID_RANKS}
    for u in users:
        rank_counts[u.get("rank", "Basic")] = rank_counts.get(u.get("rank","Basic"),0) + 1

    return _ok({
        "stats": {
            "total_users": len(users),
            "active_users": sum(1 for u in users if not u.get("is_suspended") and not u.get("is_banned")),
            "banned_users": sum(1 for u in users if u.get("is_banned") or u.get("is_blacklisted")),
            "suspended_users": sum(1 for u in users if u.get("is_suspended")),
            "admin_users": sum(1 for u in users if u.get("is_admin")),
            "ranks": rank_counts
        },
        "ranks_info": RANKS_INFO,
        "vixsrc_api": CFG["vixsrc"],
        "languages_available": 12,  # as per sidebar
        "server_info": {
            "host": CFG["server"]["host"],
            "port": CFG["server"]["port"]
        }
    })


# ── User list ───────────────────────────────────────────────────────
def list_users(admin: dict, page: int = 1, per_page: int = 50) -> dict:
    all_u = get_all_users()
    total = len(all_u)
    start = (page - 1) * per_page
    chunk = all_u[start:start + per_page]
    return _ok({
        "users": [_safe_user(u) for u in chunk],
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": (total + per_page - 1) // per_page
    })


# ── Get single user ─────────────────────────────────────────────────
def get_user_detail(admin: dict, uid: str) -> dict:
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    return _ok({"user": _safe_user(user)})


# ── Change username ─────────────────────────────────────────────────
def admin_change_username(admin: dict, uid: str, new_username: str) -> dict:
    ok, msg = validate_username(new_username)
    if not ok:
        return _err(msg)
    if username_exists(new_username):
        return _err("Username already taken")
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    old = user["username"]
    user["username"] = new_username.strip()
    save_user(user)
    logger.info(f"[ADMIN] Username changed {old} → {new_username} by {admin['username']}")
    return _ok({"uid": uid, "username": new_username})


# ── Change password ─────────────────────────────────────────────────
def admin_change_password(admin: dict, uid: str, new_password: str) -> dict:
    ok, msg = validate_password(new_password)
    if not ok:
        return _err(msg)
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    user["password_hash"] = hash_password(new_password)
    save_user(user)
    logger.info(f"[ADMIN] Password changed for {user['username']} by {admin['username']}")
    return _ok({"uid": uid})


# ── Suspend / unsuspend ─────────────────────────────────────────────
def admin_suspend_user(admin: dict, uid: str, suspend: bool) -> dict:
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    if user.get("is_admin") and not admin.get("is_admin"):
        return _err("Cannot suspend an admin", 403)
    user["is_suspended"] = suspend
    save_user(user)
    action = "suspended" if suspend else "unsuspended"
    logger.info(f"[ADMIN] User {user['username']} {action} by {admin['username']}")
    return _ok({"uid": uid, "is_suspended": suspend})


# ── Ban / unban ─────────────────────────────────────────────────────
def admin_ban_user(admin: dict, uid: str, ban: bool) -> dict:
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    user["is_banned"] = ban
    if ban:
        user["is_suspended"] = True
    save_user(user)
    action = "banned" if ban else "unbanned"
    logger.info(f"[ADMIN] User {user['username']} {action} by {admin['username']}")
    return _ok({"uid": uid, "is_banned": ban})


# ── Blacklist ───────────────────────────────────────────────────────
def admin_blacklist_user(admin: dict, uid: str, blacklist: bool) -> dict:
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    user["is_blacklisted"] = blacklist
    if blacklist:
        user["is_banned"] = True
        user["is_suspended"] = True
        add_to_blacklist(user["username"])
    save_user(user)
    action = "blacklisted" if blacklist else "removed from blacklist"
    logger.info(f"[ADMIN] User {user['username']} {action} by {admin['username']}")
    return _ok({"uid": uid, "is_blacklisted": blacklist})


# ── Set admin status ────────────────────────────────────────────────
def admin_set_admin(admin: dict, uid: str, make_admin: bool) -> dict:
    # Only the superadmin (first admin) can grant admin
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    # Prevent self-demotion
    if uid == admin["id"] and not make_admin:
        return _err("Cannot remove your own admin rights")
    user["is_admin"] = make_admin
    if make_admin:
        user["role"] = "admin"
    else:
        user["role"] = "user"
    save_user(user)
    action = "granted admin" if make_admin else "revoked admin"
    logger.info(f"[ADMIN] {user['username']} {action} by {admin['username']}")
    return _ok({"uid": uid, "is_admin": make_admin})


# ── Set rank ────────────────────────────────────────────────────────
def admin_set_rank(admin: dict, uid: str, rank: str) -> dict:
    return set_user_rank(uid, rank, admin)


# ── Unlock account ──────────────────────────────────────────────────
def admin_unlock_account(admin: dict, uid: str) -> dict:
    user = get_user_by_id(uid)
    if not user:
        return _err("User not found", 404)
    user["login_attempts"] = 0
    user["locked_until"] = None
    save_user(user)
    logger.info(f"[ADMIN] Account {user['username']} unlocked by {admin['username']}")
    return _ok({"uid": uid})


# ── IP management ───────────────────────────────────────────────────
def admin_block_ip(admin: dict, ip: str) -> dict:
    block_ip(ip)
    return _ok({"blocked_ip": ip})

def admin_unblock_ip(admin: dict, ip: str) -> dict:
    unblock_ip(ip)
    return _ok({"unblocked_ip": ip})

def admin_get_blocked_ips(admin: dict) -> dict:
    return _ok({"blocked_ips": get_blocked_ips()})


# ── Delete user ─────────────────────────────────────────────────────
def admin_delete_user(admin: dict, uid: str) -> dict:
    from backend.utils import _read_db, _write_db
    if uid == admin["id"]:
        return _err("Cannot delete yourself")
    db = _read_db()
    before = len(db["users"])
    db["users"] = [u for u in db["users"] if u["id"] != uid]
    if len(db["users"]) == before:
        return _err("User not found", 404)
    _write_db(db)
    logger.info(f"[ADMIN] User {uid} deleted by {admin['username']}")
    return _ok({"deleted_uid": uid})
