"""
StreamVault Backend — security.py
Rate limiting, CSRF, security headers, brute-force protection
All security enforced SERVER-SIDE, never exposed to client.
"""
import time, hashlib, hmac, os, threading
from collections import defaultdict
from functools import wraps
from http.server import BaseHTTPRequestHandler
from backend.utils import logger, CFG, SECRET_KEY

# ── Thread-safe rate limiter ────────────────────────────────────────
_lock = threading.Lock()

class _RateBucket:
    def __init__(self, limit: int, window: int):
        self.limit = limit      # max requests
        self.window = window    # seconds
        self.hits: list[float] = []

    def is_allowed(self) -> bool:
        now = time.time()
        with _lock:
            self.hits = [t for t in self.hits if now - t < self.window]
            if len(self.hits) >= self.limit:
                return False
            self.hits.append(now)
            return True

_rate_buckets: dict[str, _RateBucket] = {}

def _bucket_key(ip: str, endpoint: str) -> str:
    return f"{ip}::{endpoint}"

def check_rate_limit(ip: str, endpoint: str, limit: int, window: int = 60) -> bool:
    key = _bucket_key(ip, endpoint)
    if key not in _rate_buckets:
        _rate_buckets[key] = _RateBucket(limit, window)
    return _rate_buckets[key].is_allowed()


# ── CSRF token (double-submit cookie pattern) ───────────────────────
def generate_csrf_token(session_id: str) -> str:
    ts = str(int(time.time() // 300))  # 5-min window
    raw = f"{session_id}:{ts}:{SECRET_KEY}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]

def verify_csrf_token(session_id: str, token: str) -> bool:
    if not token or not session_id:
        return False
    # Accept current and previous 5-min window
    for delta in (0, 1):
        ts = str((int(time.time()) // 300) - delta)
        raw = f"{session_id}:{ts}:{SECRET_KEY}"
        expected = hashlib.sha256(raw.encode()).hexdigest()[:32]
        if hmac.compare_digest(expected, token):
            return True
    return False


# ── Security headers dict ───────────────────────────────────────────
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https://image.tmdb.org https://via.placeholder.com; "
        "frame-src https://vixsrc.to https://player.videasy.net https://embed.streammafia.to https://vidsrc.to https://uembed.xyz; "
        "connect-src 'self' https://api.themoviedb.org; "
        "object-src 'none'; base-uri 'self';"
    )
}

def apply_security_headers(headers: dict) -> dict:
    """Merge security headers into a response headers dict."""
    return {**SECURITY_HEADERS, **headers}


# ── IP extraction (handles proxy headers, Cloudflare CF-Connecting-IP) ──
def get_client_ip(environ: dict) -> str:
    for hdr in ("HTTP_CF_CONNECTING_IP", "HTTP_X_REAL_IP", "HTTP_X_FORWARDED_FOR"):
        val = environ.get(hdr, "")
        if val:
            return val.split(",")[0].strip()
    return environ.get("REMOTE_ADDR", "0.0.0.0")


# ── Suspicious pattern detection ───────────────────────────────────
import re as _re

_SQLI_PATTERNS = _re.compile(
    r"(union\s+select|drop\s+table|insert\s+into|or\s+1\s*=\s*1|--|;|/\*|\*/)",
    _re.IGNORECASE
)
_XSS_PATTERNS = _re.compile(
    r"(<script|javascript:|on\w+=|<iframe|<object|<embed|alert\s*\()",
    _re.IGNORECASE
)
_PATH_TRAVERSAL = _re.compile(r"\.\./|\.\.\\|%2e%2e")

def is_malicious_input(value: str) -> bool:
    if not isinstance(value, str):
        return False
    return bool(
        _SQLI_PATTERNS.search(value) or
        _XSS_PATTERNS.search(value) or
        _PATH_TRAVERSAL.search(value)
    )

def scan_request_body(body: dict) -> bool:
    """Returns True if any value looks malicious."""
    for v in body.values():
        if isinstance(v, str) and is_malicious_input(v):
            return True
    return False


# ── Blocked IP set (in-memory, can be persisted) ────────────────────
_blocked_ips: set[str] = set()

def block_ip(ip: str) -> None:
    _blocked_ips.add(ip)
    logger.warning(f"[SECURITY] Blocked IP: {ip}")

def is_ip_blocked(ip: str) -> bool:
    return ip in _blocked_ips

def unblock_ip(ip: str) -> None:
    _blocked_ips.discard(ip)

def get_blocked_ips() -> list:
    return list(_blocked_ips)


# ── Request size limiter ─────────────────────────────────────────────
MAX_BODY_BYTES = 64 * 1024  # 64 KB


# ── Honeypot field checker (bots fill hidden fields) ────────────────
def check_honeypot(body: dict, field: str = "email") -> bool:
    """Returns True (honeypot triggered) if the hidden field has a value."""
    val = body.get(field, "")
    return bool(val and val.strip())
