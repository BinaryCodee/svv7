/**
 * StreamVault — auth.js
 * Frontend auth integration. No secrets here — all auth logic is server-side.
 * This file only reads the injected user session and updates UI accordingly.
 */
(function () {
  'use strict';

  // ── Read server-injected user context ─────────────────────────────
  // Server renders this safely; no token/hash ever exposed here.
  let _user = null;
  try {
    const el = document.getElementById('_svUser');
    if (el) _user = JSON.parse(el.textContent || '{}');
  } catch (_) { _user = null; }

  const isLoggedIn = _user && _user.logged_in;
  const isAdmin    = _user && _user.is_admin;

  // ── Rank color map ─────────────────────────────────────────────────
  const RANK_COLORS = { Basic: '#8B72FF', Medium: '#00C4FF', Premium: '#F5C842' };
  const RANK_ICONS  = { Basic: '⚡', Medium: '💎', Premium: '👑' };

  // ── Sidebar auth buttons ───────────────────────────────────────────
  function renderSidebarAuth() {
    const el = document.getElementById('sb-auth-btns');
    if (!el) return;

    if (!isLoggedIn) {
      el.innerHTML = `
        <a href="/login"  class="btn-ghost   btn-sm" style="flex:1;display:flex;align-items:center;justify-content:center;border-radius:40px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer;text-decoration:none;color:rgba(255,255,255,.62);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);margin-right:6px">Log In</a>
        <a href="/register" class="btn-primary btn-sm" style="flex:1;display:flex;align-items:center;justify-content:center;border-radius:40px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer;text-decoration:none;color:white;background:#6246EA;box-shadow:0 2px 12px rgba(98,70,234,.4)">Sign Up</a>
      `;
      el.style.cssText = 'display:flex;gap:6px;flex:1';
    } else {
      const rankColor = RANK_COLORS[_user.rank] || '#8B72FF';
      const rankIcon  = RANK_ICONS[_user.rank] || '⚡';
      el.innerHTML = `
        <div style="width:100%">
          <div style="display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:10px;background:rgba(255,255,255,.05);margin-bottom:6px">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(98,70,234,.22);border:1px solid rgba(98,70,234,.3);display:flex;align-items:center;justify-content:center;font-size:13px">👤</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(_user.username)}</div>
              <div style="font-size:9px;font-weight:700;color:${rankColor}">${rankIcon} ${_user.rank}</div>
            </div>
            ${isAdmin ? '<span style="font-size:8px;font-weight:700;color:#FF5E6A;background:rgba(255,94,106,.12);border:1px solid rgba(255,94,106,.22);padding:1px 5px;border-radius:10px">ADMIN</span>' : ''}
          </div>
          <div style="display:flex;gap:5px">
            ${isAdmin ? `<a href="${window._adminPath||''}" style="flex:1;display:flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:40px;font-size:10px;font-weight:600;background:rgba(255,94,106,.1);border:1px solid rgba(255,94,106,.22);color:#FF5E6A;text-decoration:none">⚙️ Admin</a>` : ''}
            <button onclick="svLogout()" style="flex:1;padding:5px 10px;border-radius:40px;font-size:10px;font-weight:600;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.11);color:rgba(255,255,255,.6);cursor:pointer;font-family:inherit">Logout</button>
          </div>
        </div>`;
      el.style.cssText = 'display:block;width:100%';
    }
  }

  // ── Logout ─────────────────────────────────────────────────────────
  window.svLogout = async function () {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    window.location.href = '/login';
  };

  // ── Override openPopup for login/register to redirect instead ─────
  // (keeps compatibility with any leftover calls in all.js)
  window.openPopup = function (id) {
    if (id === 'popup-login')    { window.location.href = '/login';    return; }
    if (id === 'popup-register') { window.location.href = '/register'; return; }
    // fallback for other popups
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  };

  // ── Rank-gated player wrapper ──────────────────────────────────────
  // Intercepts player start to check screen limit server-side.
  const _origModalStartPlayer = window.modalStartPlayer;
  window.modalStartPlayer = async function () {
    if (!isLoggedIn) {
      window.location.href = '/login';
      return;
    }
    // Check screen slot on server before allowing embed
    const sk = _sessionKey();
    try {
      const res = await fetch(`/api/player/open?sk=${encodeURIComponent(sk)}`, {
        credentials: 'same-origin'
      });
      const data = await res.json();
      if (!data.allowed) {
        // Show toast using app's toast system if available
        if (window.showToast) window.showToast(`⛔ ${data.reason}`, 'error');
        else alert(data.reason);
        return;
      }
    } catch (_) { /* network error — allow locally */ }

    // Register close event to release screen slot
    window.addEventListener('beforeunload', _releaseScreen, { once: true });

    // Call original
    if (typeof _origModalStartPlayer === 'function') {
      _origModalStartPlayer.call(window);
    }
  };

  // Wrap modalStopPlayer to release screen
  const _origStop = window.modalStopPlayer;
  window.modalStopPlayer = function () {
    _releaseScreen();
    if (typeof _origStop === 'function') _origStop.call(window);
  };

  function _sessionKey() {
    if (!window._svScreenKey) {
      window._svScreenKey = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    return window._svScreenKey;
  }

  function _releaseScreen() {
    const sk = window._svScreenKey;
    if (!sk || !isLoggedIn) return;
    // Use sendBeacon so it fires even on page unload
    navigator.sendBeacon(`/api/player/close?sk=${encodeURIComponent(sk)}`);
    window._svScreenKey = null;
  }

  // ── Expose admin panel path safely ────────────────────────────────
  // Only set if user is actually an admin (server confirmed)
  if (isAdmin) {
    // Injected by template — read from meta-like element if present
    const apEl = document.getElementById('_adminPath');
    if (apEl) window._adminPath = apEl.textContent.trim();
  }

  // ── Utils ─────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Init ───────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', renderSidebarAuth);
  // Also try immediately in case DOM is already ready
  if (document.readyState !== 'loading') renderSidebarAuth();

})();
