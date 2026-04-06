from __future__ import annotations
"""
StreamVault Backend — utils.py
Shared utilities: DB access, password hashing, JWT, logging
"""
import json, os, hashlib, hmac, time, uuid, logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
USERS_FILE = DATA_DIR / "users.json"
CONFIG_FILE = DATA_DIR / "config.json"

# ── Logger ──────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("streamvault")


# ── Config ──────────────────────────────────────────────────────────
def load_config() -> dict:
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

CFG = load_config()
SECRET_KEY = CFG["security"]["secret_key"]
RANKS = CFG["ranks"]


# ── DB helpers ──────────────────────────────────────────────────────
def _read_db() -> dict:
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def _write_db(data: dict) -> None:
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def get_all_users() -> list:
    return _read_db().get("users", [])

def get_user_by_username(username: str) -> dict | None:
    db = _read_db()
    un = username.strip().lower()
    for u in db["users"]:
        if u["username"].lower() == un:
            return u
    return None

def get_user_by_id(uid: str) -> dict | None:
    db = _read_db()
    for u in db["users"]:
        if u["id"] == uid:
            return u
    return None

def save_user(user: dict) -> None:
    db = _read_db()
    for i, u in enumerate(db["users"]):
        if u["id"] == user["id"]:
            db["users"][i] = user
            _write_db(db)
            return
    db["users"].append(user)
    _write_db(db)

def create_user(username: str, password: str, rank: str = "Basic") -> dict:
    user = {
        "id": str(uuid.uuid4()),
        "username": username.strip(),
        "password_hash": hash_password(password),
        "role": "user",
        "rank": rank,
        "is_admin": False,
        "is_suspended": False,
        "is_banned": False,
        "is_blacklisted": False,
        "created_at": utcnow(),
        "last_login": None,
        "active_screens": 0,
        "login_attempts": 0,
        "locked_until": None
    }
    save_user(user)
    return user

def username_exists(username: str) -> bool:
    return get_user_by_username(username) is not None

def get_blacklist() -> list:
    return _read_db().get("blacklist", [])

def add_to_blacklist(username: str) -> None:
    db = _read_db()
    if username not in db.get("blacklist", []):
        db.setdefault("blacklist", []).append(username)
    _write_db(db)


# ── Password hashing (PBKDF2-SHA256 + unique salt) ─────────────────
HASH_ITERATIONS = 310_000

def hash_password(password: str) -> str:
    salt = os.urandom(32).hex()
    h = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), HASH_ITERATIONS
    ).hex()
    return f"{salt}:{h}"

def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, hash_hex = stored_hash.split(":", 1)
        expected = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), HASH_ITERATIONS
        ).hex()
        return hmac.compare_digest(expected, hash_hex)
    except Exception:
        return False


# ── JWT (pure stdlib — no PyJWT dependency) ─────────────────────────
import base64

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * padding)

def create_token(payload: dict, expiry_hours: int = 24) -> str:
    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    exp = int(time.time()) + expiry_hours * 3600
    body_data = {**payload, "exp": exp, "iat": int(time.time())}
    body = _b64url_encode(json.dumps(body_data).encode())
    sig_input = f"{header}.{body}".encode()
    sig = hmac.new(SECRET_KEY.encode(), sig_input, hashlib.sha256).digest()
    return f"{header}.{body}.{_b64url_encode(sig)}"

def verify_token(token: str) -> dict | None:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header, body, sig = parts
        sig_input = f"{header}.{body}".encode()
        expected_sig = hmac.new(SECRET_KEY.encode(), sig_input, hashlib.sha256).digest()
        actual_sig = _b64url_decode(sig)
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
        payload = json.loads(_b64url_decode(body))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


# ── Rank utilities ──────────────────────────────────────────────────
def get_rank_info(rank: str) -> dict:
    return RANKS.get(rank, RANKS["Basic"])

def rank_allows_1080p(rank: str) -> bool:
    return get_rank_info(rank).get("hd_1080p", False)

def rank_allows_downloads(rank: str) -> bool:
    return get_rank_info(rank).get("downloads", False)

def rank_max_screens(rank: str) -> int:
    return get_rank_info(rank).get("max_screens", 2)

def rank_no_ads(rank: str) -> bool:
    return get_rank_info(rank).get("no_ads", True)

def rank_priority(rank: str) -> int:
    return get_rank_info(rank).get("priority", 3)


# ── Time utils ──────────────────────────────────────────────────────
def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()

def is_locked(user: dict) -> bool:
    locked = user.get("locked_until")
    if not locked:
        return False
    try:
        lock_dt = datetime.fromisoformat(locked)
        return datetime.now(timezone.utc) < lock_dt
    except Exception:
        return False

def lock_account(user: dict, minutes: int = 15) -> dict:
    until = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
    user["locked_until"] = until
    return user


# ── Input sanitization ──────────────────────────────────────────────
import re

_USERNAME_RE = re.compile(r'^[a-zA-Z0-9_\-\.]{3,32}$')

def validate_username(username: str) -> tuple[bool, str]:
    if not username or not isinstance(username, str):
        return False, "Username required"
    username = username.strip()
    if not _USERNAME_RE.match(username):
        return False, "Username must be 3-32 chars: letters, digits, _ - ."
    return True, ""

def validate_password(password: str) -> tuple[bool, str]:
    if not password or not isinstance(password, str):
        return False, "Password required"
    if len(password) < 8:
        return False, "Password must be at least 8 characters"
    if len(password) > 128:
        return False, "Password too long"
    return True, ""

def sanitize_str(s: str, maxlen: int = 256) -> str:
    if not isinstance(s, str):
        return ""
    return s.strip()[:maxlen]
