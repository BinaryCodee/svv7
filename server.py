from __future__ import annotations
"""
StreamVault — server.py
Custom HTTP server with built-in request poller.
Handles: GET/POST routing, auth, admin, player, static files.
All security enforced server-side before any response is sent.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json, mimetypes, threading, time, traceback, urllib.parse, queue
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from functools import partial

from backend.utils import logger, CFG
from backend.security import (
    apply_security_headers, get_client_ip, is_ip_blocked,
    check_rate_limit, MAX_BODY_BYTES, SECURITY_HEADERS
)
from backend.auth import (
    handle_login, handle_register, handle_logout,
    get_current_user, require_auth, require_admin
)
from backend.admin import (
    get_dashboard_stats, list_users, get_user_detail,
    admin_change_username, admin_change_password,
    admin_suspend_user, admin_ban_user, admin_blacklist_user,
    admin_set_admin, admin_set_rank, admin_unlock_account,
    admin_block_ip, admin_unblock_ip, admin_get_blocked_ips,
    admin_delete_user
)
from backend.ranks import (
    build_player_url, check_download_access, check_1080p_access,
    open_screen, close_screen, get_all_ranks_info, get_active_screens
)

BASE_DIR      = Path(__file__).resolve().parent
FRONTEND_DIR  = BASE_DIR / "frontend"
TEMPLATES_DIR = FRONTEND_DIR / "templates"
STATIC_DIR    = FRONTEND_DIR / "static"

ADMIN_PATH = CFG["security"]["admin_panel_path"]
COOKIE_NAME = CFG["security"]["session_cookie_name"]
JWT_EXPIRY  = CFG["security"]["jwt_expiry_hours"]

# ── Request polling queue (async task tracking) ────────────────────
_poll_queue: queue.Queue = queue.Queue(maxsize=512)

def _enqueue_request(method: str, path: str, ip: str, status: int) -> None:
    try:
        _poll_queue.put_nowait({
            "ts": time.time(), "method": method,
            "path": path, "ip": ip, "status": status
        })
    except queue.Full:
        _poll_queue.get_nowait()
        _poll_queue.put_nowait({
            "ts": time.time(), "method": method,
            "path": path, "ip": ip, "status": status
        })

_poll_log: list[dict] = []
_poll_lock = threading.Lock()
_POLL_MAX = 200   # keep last 200 requests in memory

def _poller_worker() -> None:
    """Background thread: drains poll_queue → _poll_log."""
    while True:
        try:
            item = _poll_queue.get(timeout=1)
            with _poll_lock:
                _poll_log.append(item)
                if len(_poll_log) > _POLL_MAX:
                    _poll_log.pop(0)
        except queue.Empty:
            pass

threading.Thread(target=_poller_worker, daemon=True, name="poller").start()


# ── JSON helpers ────────────────────────────────────────────────────
def _json_response(data: dict, status: int = 200, extra_headers: dict = None) -> tuple:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
        **(extra_headers or {})
    }
    return status, headers, body

def _html_response(html: str, status: int = 200) -> tuple:
    body = html.encode("utf-8")
    return status, {"Content-Type": "text/html; charset=utf-8", "Content-Length": str(len(body))}, body

def _redirect(location: str, status: int = 302) -> tuple:
    return status, {"Location": location, "Content-Length": "0"}, b""

def _not_found() -> tuple:
    return _json_response({"error": "Not found"}, 404)

def _forbidden() -> tuple:
    return _json_response({"error": "Forbidden"}, 403)

def _method_not_allowed() -> tuple:
    return _json_response({"error": "Method not allowed"}, 405)


# ── Template rendering ──────────────────────────────────────────────
def render_template(name: str, ctx: dict = None) -> str:
    path = TEMPLATES_DIR / name
    if not path.exists():
        return f"<h1>Template not found: {name}</h1>"
    html = path.read_text(encoding="utf-8")
    for key, val in (ctx or {}).items():
        html = html.replace("{{" + key + "}}", str(val))
    return html


# ── Static file server ─────────────────────────────────────────────
def serve_static(rel_path: str) -> tuple:
    safe = rel_path.lstrip("/").replace("..", "")
    file_path = STATIC_DIR / safe
    if not file_path.exists() or not file_path.is_file():
        return _not_found()
    mime, _ = mimetypes.guess_type(str(file_path))
    data = file_path.read_bytes()
    return 200, {
        "Content-Type": mime or "application/octet-stream",
        "Content-Length": str(len(data)),
        "Cache-Control": "public, max-age=3600"
    }, data


# ══════════════════════════════════════════════════════════════════════
#  ROUTE HANDLER
# ══════════════════════════════════════════════════════════════════════
class StreamVaultHandler(BaseHTTPRequestHandler):
    server_version = "StreamVault/7"
    sys_version = ""

    # ── Suppress default logging (we use our own) ──────────────────
    def log_message(self, fmt, *args): pass
    def log_request(self, *args): pass

    # ── Read body ─────────────────────────────────────────────────
    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY_BYTES:
            return b""
        return self.rfile.read(length) if length > 0 else b""

    def _parse_json_body(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _parse_form_body(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        return dict(urllib.parse.parse_qsl(raw.decode("utf-8")))

    # ── Header helpers ────────────────────────────────────────────
    def _get_headers_dict(self) -> dict:
        return dict(self.headers)

    def _get_ip(self) -> str:
        env = {
            "REMOTE_ADDR": self.client_address[0],
            "HTTP_X_FORWARDED_FOR": self.headers.get("X-Forwarded-For", ""),
            "HTTP_X_REAL_IP": self.headers.get("X-Real-IP", ""),
            "HTTP_CF_CONNECTING_IP": self.headers.get("CF-Connecting-IP", "")
        }
        return get_client_ip(env)

    # ── Send response ─────────────────────────────────────────────
    def _send(self, status: int, headers: dict, body: bytes) -> None:
        all_headers = apply_security_headers(headers)
        self.send_response(status)
        for k, v in all_headers.items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    # ── Cookie setter ─────────────────────────────────────────────
    def _set_auth_cookie(self, token: str) -> str:
        expiry = int(time.time()) + JWT_EXPIRY * 3600
        return f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={JWT_EXPIRY*3600}"

    def _clear_auth_cookie(self) -> str:
        return f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"

    # ── Parse path + query ────────────────────────────────────────
    def _parse_url(self) -> tuple[str, dict]:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = dict(urllib.parse.parse_qsl(parsed.query))
        return path, qs

    # ══════════════════════════════════════════════════════════════
    #  GET handler
    # ══════════════════════════════════════════════════════════════
    def do_GET(self):
        ip = self._get_ip()
        path, qs = self._parse_url()

        # IP block check
        if is_ip_blocked(ip):
            s, h, b = _forbidden()
            _enqueue_request("GET", path, ip, 403)
            return self._send(s, h, b)

        # Global rate limit on all requests
        if not check_rate_limit(ip, "global", 300, 60):
            s, h, b = _json_response({"error": "Rate limit exceeded"}, 429)
            _enqueue_request("GET", path, ip, 429)
            return self._send(s, h, b)

        try:
            s, h, b = self._route_get(path, qs, ip)
        except Exception:
            logger.error(traceback.format_exc())
            s, h, b = _json_response({"error": "Internal server error"}, 500)

        _enqueue_request("GET", path, ip, s)
        self._send(s, h, b)

    def _route_get(self, path: str, qs: dict, ip: str) -> tuple:
        hdrs = self._get_headers_dict()
        user = get_current_user(hdrs)

        # ── Static files ──────────────────────────────────────────
        if path.startswith("/static/"):
            return serve_static(path[8:])

        # ── Service worker ────────────────────────────────────────
        if path == "/sw.js":
            return serve_static("sw.js")

        # ── Main app (SPA shell) ──────────────────────────────────
        if path in ("/", "/home", "/movies", "/shows", "/trending", "/wishlist"):
            html = render_template("index.html", {
                "USER_JSON": json.dumps(_public_user_ctx(user)),
                "ADMIN_PANEL_PATH": ADMIN_PATH if user and user.get("is_admin") else ""
            })
            return _html_response(html)

        # ── Auth pages ────────────────────────────────────────────
        if path == "/login":
            if user:
                return _redirect("/")
            return _html_response(render_template("login.html"))

        if path == "/register":
            if user:
                return _redirect("/")
            return _html_response(render_template("register.html"))

        # ── Admin panel ───────────────────────────────────────────
        if path == ADMIN_PATH:
            err = require_admin(user)
            if err:
                return _redirect("/login")
            html = render_template("admin/panel.html", {
                "ADMIN_USERNAME": user["username"],
                "ADMIN_PANEL_PATH": ADMIN_PATH
            })
            return _html_response(html)

        # ── API: current user ─────────────────────────────────────
        if path == "/api/me":
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            return _json_response({"ok": True, "user": _public_user_ctx(user)})

        # ── API: ranks info ───────────────────────────────────────
        if path == "/api/ranks":
            return _json_response({"ok": True, "ranks": get_all_ranks_info()})

        # ── API: player URL (rank-gated) ──────────────────────────
        if path == "/api/player/url":
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            try:
                tmdb_id = int(qs.get("id", 0))
                media_type = qs.get("type", "movie")
                season  = int(qs.get("season", 1)) if media_type == "tv" else None
                episode = int(qs.get("episode", 1)) if media_type == "tv" else None
                lang = qs.get("lang", "it")
            except (ValueError, TypeError):
                return _json_response({"ok": False, "error": "Invalid params"}, 400)
            result = build_player_url(user, media_type, tmdb_id, season, episode, lang)
            return _json_response({"ok": True, **result})

        # ── API: open screen ──────────────────────────────────────
        if path == "/api/player/open":
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            session_key = qs.get("sk", "")
            result = open_screen(user["id"], session_key or ip)
            code = 200 if result.get("allowed") else 403
            return _json_response(result, code)

        # ── API: close screen ─────────────────────────────────────
        if path == "/api/player/close":
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            session_key = qs.get("sk", "")
            close_screen(user["id"], session_key or ip)
            return _json_response({"ok": True})

        # ── API: download access check ────────────────────────────
        if path == "/api/download/check":
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            return _json_response(check_download_access(user))

        # ── API: 1080p access check ───────────────────────────────
        if path == "/api/quality/check":
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            return _json_response(check_1080p_access(user))

        # ── Admin API: stats ──────────────────────────────────────
        if path == "/api/admin/stats":
            err = require_admin(user)
            if err:
                return _json_response(err, err["code"])
            return _json_response(get_dashboard_stats(user))

        # ── Admin API: users list ─────────────────────────────────
        if path == "/api/admin/users":
            err = require_admin(user)
            if err:
                return _json_response(err, err["code"])
            page = int(qs.get("page", 1))
            return _json_response(list_users(user, page))

        # ── Admin API: user detail ────────────────────────────────
        if path.startswith("/api/admin/user/"):
            err = require_admin(user)
            if err:
                return _json_response(err, err["code"])
            uid = path.split("/")[-1]
            return _json_response(get_user_detail(user, uid))

        # ── Admin API: poll log ───────────────────────────────────
        if path == "/api/admin/poll":
            err = require_admin(user)
            if err:
                return _json_response(err, err["code"])
            with _poll_lock:
                log = list(reversed(_poll_log[-50:]))
            return _json_response({"ok": True, "log": log})

        # ── Admin API: blocked IPs ────────────────────────────────
        if path == "/api/admin/blocked-ips":
            err = require_admin(user)
            if err:
                return _json_response(err, err["code"])
            return _json_response(admin_get_blocked_ips(user))

        # ── TMDB proxy (hides API key from client) ────────────────
        if path.startswith("/api/tmdb/"):
            err = require_auth(user)
            if err:
                return _json_response(err, err["code"])
            return self._proxy_tmdb(path[10:], qs)

        return _not_found()

    # ══════════════════════════════════════════════════════════════
    #  POST handler
    # ══════════════════════════════════════════════════════════════
    def do_POST(self):
        ip = self._get_ip()
        path, qs = self._parse_url()

        if is_ip_blocked(ip):
            s, h, b = _forbidden()
            _enqueue_request("POST", path, ip, 403)
            return self._send(s, h, b)

        if not check_rate_limit(ip, "global", 300, 60):
            s, h, b = _json_response({"error": "Rate limit exceeded"}, 429)
            _enqueue_request("POST", path, ip, 429)
            return self._send(s, h, b)

        try:
            s, h, b = self._route_post(path, qs, ip)
        except Exception:
            logger.error(traceback.format_exc())
            s, h, b = _json_response({"error": "Internal server error"}, 500)

        _enqueue_request("POST", path, ip, s)
        self._send(s, h, b)

    def _route_post(self, path: str, qs: dict, ip: str) -> tuple:
        hdrs = self._get_headers_dict()
        user = get_current_user(hdrs)
        ct   = hdrs.get("Content-Type", "") or hdrs.get("content-type", "")
        body = self._parse_json_body() if "json" in ct else self._parse_form_body()

        # ── Login ─────────────────────────────────────────────────
        if path == "/api/auth/login":
            if not check_rate_limit(ip, "login", CFG["security"]["rate_limit_login"], 60):
                return _json_response({"ok": False, "error": "Too many login attempts"}, 429)
            result = handle_login(body, ip)
            status = 200 if result.get("ok") else result.get("code", 400)
            extra = {}
            if result.get("ok") and result.get("token"):
                extra["Set-Cookie"] = self._set_auth_cookie(result["token"])
            return _json_response(result, status, extra)

        # ── Register ──────────────────────────────────────────────
        if path == "/api/auth/register":
            if not check_rate_limit(ip, "register", CFG["security"]["rate_limit_register"], 600):
                return _json_response({"ok": False, "error": "Too many registrations"}, 429)
            result = handle_register(body, ip)
            status = 200 if result.get("ok") else result.get("code", 400)
            extra = {}
            if result.get("ok") and result.get("token"):
                extra["Set-Cookie"] = self._set_auth_cookie(result["token"])
            return _json_response(result, status, extra)

        # ── Logout ────────────────────────────────────────────────
        if path == "/api/auth/logout":
            result = handle_logout(user)
            return _json_response(result, 200, {"Set-Cookie": self._clear_auth_cookie()})

        # ── Admin: change username ─────────────────────────────────
        if path == "/api/admin/user/username":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            new_un = body.get("username", "")
            return _json_response(admin_change_username(user, uid, new_un))

        # ── Admin: change password ────────────────────────────────
        if path == "/api/admin/user/password":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            new_pw = body.get("password", "")
            return _json_response(admin_change_password(user, uid, new_pw))

        # ── Admin: suspend ────────────────────────────────────────
        if path == "/api/admin/user/suspend":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            suspend = bool(body.get("suspend", True))
            return _json_response(admin_suspend_user(user, uid, suspend))

        # ── Admin: ban ────────────────────────────────────────────
        if path == "/api/admin/user/ban":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            ban = bool(body.get("ban", True))
            return _json_response(admin_ban_user(user, uid, ban))

        # ── Admin: blacklist ──────────────────────────────────────
        if path == "/api/admin/user/blacklist":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            bl = bool(body.get("blacklist", True))
            return _json_response(admin_blacklist_user(user, uid, bl))

        # ── Admin: set admin ──────────────────────────────────────
        if path == "/api/admin/user/admin":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            make_admin = bool(body.get("is_admin", False))
            return _json_response(admin_set_admin(user, uid, make_admin))

        # ── Admin: set rank ───────────────────────────────────────
        if path == "/api/admin/user/rank":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            rank = body.get("rank", "Basic")
            return _json_response(admin_set_rank(user, uid, rank))

        # ── Admin: unlock account ─────────────────────────────────
        if path == "/api/admin/user/unlock":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            return _json_response(admin_unlock_account(user, uid))

        # ── Admin: block IP ───────────────────────────────────────
        if path == "/api/admin/block-ip":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            block_ip_val = body.get("ip", "")
            return _json_response(admin_block_ip(user, block_ip_val))

        # ── Admin: unblock IP ─────────────────────────────────────
        if path == "/api/admin/unblock-ip":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            block_ip_val = body.get("ip", "")
            return _json_response(admin_unblock_ip(user, block_ip_val))

        # ── Admin: delete user ────────────────────────────────────
        if path == "/api/admin/user/delete":
            err = require_admin(user)
            if err: return _json_response(err, err["code"])
            uid = body.get("uid", "")
            return _json_response(admin_delete_user(user, uid))

        return _not_found()

    # ── TMDB proxy ────────────────────────────────────────────────
    def _proxy_tmdb(self, tmdb_path: str, qs: dict) -> tuple:
        import urllib.request
        tmdb_key = CFG["tmdb"]["api_key"]
        base = CFG["tmdb"]["base_url"]
        qs_str = urllib.parse.urlencode({**qs, "api_key": tmdb_key})
        url = f"{base}/{tmdb_path}?{qs_str}"
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                data = resp.read()
                return 200, {"Content-Type": "application/json; charset=utf-8",
                             "Content-Length": str(len(data))}, data
        except Exception as e:
            logger.error(f"[TMDB proxy] {e}")
            return _json_response({"error": "TMDB proxy error"}, 502)


# ── User context for templates ─────────────────────────────────────
def _public_user_ctx(user: dict | None) -> dict:
    if not user:
        return {"logged_in": False}
    return {
        "logged_in": True,
        "id": user["id"],
        "username": user["username"],
        "rank": user.get("rank", "Basic"),
        "is_admin": user.get("is_admin", False)
    }


# ══════════════════════════════════════════════════════════════════════
#  Server factory
# ══════════════════════════════════════════════════════════════════════
class ThreadedHTTPServer(HTTPServer):
    """Handle each request in a new thread."""
    allow_reuse_address = True   # evita "Address already in use" al riavvio

    def process_request(self, request, client_address):
        t = threading.Thread(
            target=self._process_request_thread,
            args=(request, client_address),
            daemon=True
        )
        t.start()

    def _process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


def create_server(host: str, port: int) -> ThreadedHTTPServer:
    server = ThreadedHTTPServer((host, port), StreamVaultHandler)
    return server


def run_server(host: str = "0.0.0.0", port: int = 8080) -> None:
    server = create_server(host, port)
    logger.info(f"╔══════════════════════════════════════════╗")
    logger.info(f"║        StreamVault v7 — Server           ║")
    logger.info(f"╠══════════════════════════════════════════╣")
    logger.info(f"║  Listening on  http://{host}:{port:<5}        ║")
    logger.info(f"║  Admin panel   {ADMIN_PATH:<27}║")
    logger.info(f"╚══════════════════════════════════════════╝")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Server shutting down…")
        server.shutdown()


# ── Entry point (run server.py directly) ────────────────────────────
if __name__ == "__main__":
    import sys
    host = "0.0.0.0"
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run_server(host, port)
