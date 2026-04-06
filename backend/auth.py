from __future__ import annotations
"""
StreamVault Backend — auth.py
Login, register, session management, token validation.
All logic is SERVER-SIDE. No sensitive data reaches the client.
"""
import json, time
from backend.utils import (
    get_user_by_username, get_user_by_id, save_user, create_user,
    username_exists, verify_password, create_token, verify_token,
    validate_username, validate_password, is_locked, lock_account,
    utcnow, logger, CFG, get_blacklist
)
from backend.security import (
    check_rate_limit, check_honeypot, scan_request_body,
    get_client_ip, is_ip_blocked
)

MAX_ATTEMPTS = CFG["security"]["max_login_attempts"]
LOCKOUT_MIN  = CFG["security"]["lockout_minutes"]
JWT_EXPIRY   = CFG["security"]["jwt_expiry_hours"]
COOKIE_NAME  = CFG["security"]["session_cookie_name"]


# ── Auth result helpers ─────────────────────────────────────────────
def _ok(data: dict = None) -> dict:
    return {"ok": True, **(data or {})}

def _err(msg: str, code: int = 400) -> dict:
    return {"ok": False, "error": msg, "code": code}


# ── Login ───────────────────────────────────────────────────────────
def handle_login(body: dict, ip: str) -> dict:
    """
    Authenticates a user.
    Returns {"ok": True, "token": ..., "user": {...}} on success.
    """
    # IP block
    if is_ip_blocked(ip):
        logger.warning(f"[AUTH] Blocked IP attempted login: {ip}")
        return _err("Access denied", 403)

    # Rate limit: 10 attempts per minute per IP
    if not check_rate_limit(ip, "login", limit=10, window=60):
        logger.warning(f"[AUTH] Rate limit exceeded on login from {ip}")
        return _err("Too many requests. Wait and retry.", 429)

    # Honeypot (hidden email field — bots fill it, humans leave it blank)
    if check_honeypot(body, "email"):
        return _err("Bot detected", 403)

    # Malicious input scan
    if scan_request_body(body):
        logger.warning(f"[AUTH] Malicious payload on login from {ip}")
        return _err("Invalid input", 400)

    username = body.get("username", "").strip()
    password = body.get("password", "")

    # Validate
    ok, msg = validate_username(username)
    if not ok:
        return _err(msg)
    ok, msg = validate_password(password)
    if not ok:
        return _err(msg)

    user = get_user_by_username(username)
    if not user:
        # Timing-safe: always hash even on miss to prevent timing attacks
        verify_password("dummy", "a" * 64 + ":b" * 32)
        return _err("Invalid credentials", 401)

    # Lockout check
    if is_locked(user):
        return _err(f"Account locked. Try again later.", 403)

    # Ban/suspend/blacklist check
    if user.get("is_banned") or user.get("is_blacklisted"):
        return _err("Account banned. Contact support.", 403)
    if user.get("is_suspended"):
        return _err("Account suspended. Contact support.", 403)

    # Verify password
    if not verify_password(password, user["password_hash"]):
        user["login_attempts"] = user.get("login_attempts", 0) + 1
        if user["login_attempts"] >= MAX_ATTEMPTS:
            user = lock_account(user, LOCKOUT_MIN)
            logger.warning(f"[AUTH] Account locked after failed attempts: {username}")
        save_user(user)
        return _err("Invalid credentials", 401)

    # Success — reset counters
    user["login_attempts"] = 0
    user["locked_until"] = None
    user["last_login"] = utcnow()
    save_user(user)

    # Issue JWT
    token = create_token({
        "uid": user["id"],
        "username": user["username"],
        "rank": user["rank"],
        "is_admin": user.get("is_admin", False)
    }, expiry_hours=JWT_EXPIRY)

    logger.info(f"[AUTH] Login success: {username} from {ip}")
    return _ok({
        "token": token,
        "user": _public_user(user)
    })


# ── Register ────────────────────────────────────────────────────────
def handle_register(body: dict, ip: str) -> dict:
    if is_ip_blocked(ip):
        return _err("Access denied", 403)

    # Rate limit: 5 registrations per 10 min per IP
    if not check_rate_limit(ip, "register", limit=5, window=600):
        return _err("Too many registrations. Wait and retry.", 429)

    if check_honeypot(body, "email"):
        return _err("Bot detected", 403)

    if scan_request_body(body):
        return _err("Invalid input", 400)

    username = body.get("username", "").strip()
    password = body.get("password", "")
    confirm  = body.get("confirm_password", "")

    ok, msg = validate_username(username)
    if not ok:
        return _err(msg)

    ok, msg = validate_password(password)
    if not ok:
        return _err(msg)

    if password != confirm:
        return _err("Passwords do not match")

    if username_exists(username):
        return _err("Username already taken")

    user = create_user(username, password, rank="Basic")

    # Issue token immediately (auto-login after register)
    token = create_token({
        "uid": user["id"],
        "username": user["username"],
        "rank": user["rank"],
        "is_admin": False
    }, expiry_hours=JWT_EXPIRY)

    logger.info(f"[AUTH] New registration: {username} from {ip}")
    return _ok({"token": token, "user": _public_user(user)})


# ── Token validation middleware ─────────────────────────────────────
def get_current_user(request_headers: dict) -> dict | None:
    """
    Extracts and verifies JWT from Authorization header or cookie.
    Returns user dict or None.
    """
    token = None

    # Try Authorization: Bearer <token>
    auth = request_headers.get("Authorization", "") or request_headers.get("authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()

    # Try cookie
    if not token:
        cookie_str = request_headers.get("Cookie", "") or request_headers.get("cookie", "")
        for part in cookie_str.split(";"):
            part = part.strip()
            if part.startswith(f"{COOKIE_NAME}="):
                token = part[len(COOKIE_NAME)+1:].strip()
                break

    if not token:
        return None

    payload = verify_token(token)
    if not payload:
        return None

    user = get_user_by_id(payload.get("uid", ""))
    if not user:
        return None

    # Re-check active ban/suspend
    if user.get("is_banned") or user.get("is_blacklisted") or user.get("is_suspended"):
        return None

    return user


def require_auth(user: dict | None) -> dict | None:
    """Returns error dict if user is None, else None (no error)."""
    if not user:
        return {"ok": False, "error": "Authentication required", "code": 401}
    return None


def require_admin(user: dict | None) -> dict | None:
    err = require_auth(user)
    if err:
        return err
    if not user.get("is_admin"):
        return {"ok": False, "error": "Forbidden", "code": 403}
    return None


# ── Logout ──────────────────────────────────────────────────────────
def handle_logout(user: dict | None) -> dict:
    # JWT is stateless; logout is client-side cookie deletion.
    # For extra security we could maintain a server-side denylist.
    if user:
        logger.info(f"[AUTH] Logout: {user['username']}")
    return _ok({"message": "Logged out"})


# ── Public user view (no sensitive fields) ──────────────────────────
def _public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "rank": user.get("rank", "Basic"),
        "is_admin": user.get("is_admin", False),
        "is_suspended": user.get("is_suspended", False),
        "created_at": user.get("created_at")
    }
