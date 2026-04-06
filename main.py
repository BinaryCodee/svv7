"""
StreamVault — main.py
Entry point. Initializes DB, validates config, starts the HTTP server.
Run: python main.py
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pathlib import Path
from backend.utils import logger, CFG, USERS_FILE, DATA_DIR
from server import run_server

def init_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not USERS_FILE.exists():
        logger.error(f"[INIT] users.json not found at {USERS_FILE}. Please restore it from the package.")
        sys.exit(1)

def check_admin_exists() -> None:
    from backend.utils import get_all_users
    users = get_all_users()
    admins = [u for u in users if u.get("is_admin")]
    if not admins:
        logger.warning("[INIT] No admin account found in users.json!")
    else:
        logger.info(f"[INIT] Admin account(s): {[a['username'] for a in admins]}")

def print_banner() -> None:
    panel = CFG["security"]["admin_panel_path"]
    host  = CFG["server"]["host"]
    port  = CFG["server"]["port"]
    logger.info("=" * 55)
    logger.info("  StreamVault v7 — Secure Streaming Platform")
    logger.info("=" * 55)
    logger.info(f"  Site:         http://{host}:{port}/")
    logger.info(f"  Admin panel:  http://{host}:{port}{panel}")
    logger.info(f"  Login page:   http://{host}:{port}/login")
    logger.info(f"  Register:     http://{host}:{port}/register")
    logger.info("=" * 55)
    logger.info("  KEEP THE ADMIN PATH SECRET — do not share it!")
    logger.info("=" * 55)

def main() -> None:
    init_data_dir()
    check_admin_exists()
    print_banner()

    host = CFG["server"]["host"]
    port = CFG["server"]["port"]

    # Allow port override via CLI: python main.py 9000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    run_server(host, port)

if __name__ == "__main__":
    main()
