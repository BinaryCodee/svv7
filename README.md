# StreamVault v7 — Documentazione Completa

## 🚀 Avvio Rapido

```bash
# Requisiti: Python 3.11+
python main.py

# Su porta personalizzata:
python main.py 9000
```

Il server parte su `http://0.0.0.0:8080` (configurabile in `data/config.json`).

---

## 🗂️ Struttura del Progetto

```
StreamVaultV7/
├── main.py                    ← Entry point (avvia tutto)
├── server.py                  ← HTTP Server + request poller custom
├── requirements.txt
├── backend/
│   ├── __init__.py
│   ├── auth.py                ← Login / Register / JWT session
│   ├── security.py            ← Rate limit, CSRF, headers, IP ban
│   ├── admin.py               ← API pannello admin
│   ├── ranks.py               ← VIP rank system (schermi, qualità, download)
│   └── utils.py               ← DB JSON, hashing password, JWT, sanitization
├── frontend/
│   ├── templates/
│   │   ├── index.html         ← SPA principale (StreamVault)
│   │   ├── login.html         ← Pagina di login
│   │   ├── register.html      ← Pagina di registrazione
│   │   └── admin/
│   │       └── panel.html     ← Dashboard admin (URL segreto)
│   └── static/
│       ├── js/
│       │   ├── all.js         ← Logica frontend originale StreamVault
│       │   └── auth.js        ← Integrazione auth (no dati sensibili)
│       ├── sw.js              ← Service Worker
│       └── se_player.php      ← Player fallback PHP
└── data/
    ├── users.json             ← Database utenti (JSON cifrato con PBKDF2)
    └── config.json            ← Configurazione server, sicurezza, rank
```

---

## 🔐 Credenziali Admin di Default

| Campo    | Valore                          |
|----------|---------------------------------|
| Username | `vxcoadminstreaming`            |
| Password | `o1g&:GQl9x^p55Y7[Y>A)zj$8`    |

> ⚠️ Cambia la password admin dalla dashboard appena avviato.

---

## 🎛️ Pannello Admin (URL Segreto)

**Non usare `/admin`** — l'URL è nascosto e configurabile.

### URL di default:
```
http://localhost:8080/sv-ctrl-x7k9-mngmt-2025
```

Per cambiarlo, modifica `data/config.json`:
```json
"admin_panel_path": "/il-tuo-path-segreto"
```

### Funzionalità Dashboard:
- 📊 Stats utenti in tempo reale
- 👥 Gestione completa utenti (modifica username/password, rank, ruolo admin)
- ⏸ Sospensione / Ban / Blacklist account
- 🔓 Sblocco account dopo tentativi falliti
- 🗑️ Eliminazione utenti
- 🚫 Blocco/sblocco IP
- 📡 Request log in tempo reale (HTTP poller)
- ⭐ Vista dettagliata rank VIP

---

## ⭐ Sistema Rank VIP

| Feature                   | Basic | Medium | Premium |
|---------------------------|:-----:|:------:|:-------:|
| No pubblicità             | ✅    | ✅     | ✅      |
| Streaming 1080p           | ❌    | ✅     | ✅      |
| Download film/serie       | ❌    | ✅     | ✅      |
| Schermi contemporanei     | 2     | 3      | 4       |
| Priorità richieste player | 3     | 2      | 1       |

**Tutto gestito lato backend** — il frontend non può bypassare i controlli.

---

## 🛡️ Sicurezza Implementata

### Backend (server-side):
- ✅ **Password hashing** PBKDF2-SHA256 con salt casuale (310.000 iterazioni)
- ✅ **JWT custom** con firma HMAC-SHA256 (senza dipendenze esterne)
- ✅ **Rate limiting** per IP su login, register, e tutte le API
- ✅ **Brute force protection** — lockout account dopo 5 tentativi falliti
- ✅ **Honeypot anti-bot** su form login e registrazione
- ✅ **Scansione input malevolo** (SQLi, XSS, path traversal)
- ✅ **Security headers** completi (CSP, HSTS, X-Frame-Options, ecc.)
- ✅ **Blocco IP** dinamico via admin
- ✅ **TMDB API proxied** — la chiave API non viene mai esposta al client
- ✅ **Admin path nascosto** — non è `/admin`, non brute-forzabile
- ✅ **Thread-safe** — server multi-thread per gestire traffico concorrente
- ✅ **Request poller** — log completo di tutte le richieste in memoria

### Suggerimenti aggiuntivi:
- 🔧 **Cloudflare** — attiva Turnstile/WAF davanti al server
- 🔧 **Nginx reverse proxy** — usa come proxy con SSL/TLS
- 🔧 **Cambia il secret key** in `data/config.json` prima della produzione
- 🔧 **Cambia il admin panel path** in `data/config.json`

---

## 📡 API Endpoints

### Pubbliche (non richiedono auth):
| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | `/` | App principale |
| GET | `/login` | Pagina login |
| GET | `/register` | Pagina registrazione |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/register` | Registrazione |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/ranks` | Info rank VIP |

### Protette (richiedono JWT):
| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | `/api/me` | Utente corrente |
| GET | `/api/player/url` | URL player gated by rank |
| GET | `/api/player/open` | Apri schermo (check limite) |
| GET | `/api/player/close` | Chiudi schermo |
| GET | `/api/download/check` | Verifica accesso download |
| GET | `/api/quality/check` | Verifica accesso 1080p |
| GET | `/api/tmdb/*` | Proxy TMDB (API key nascosta) |

### Admin only:
| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | `/api/admin/stats` | Statistiche dashboard |
| GET | `/api/admin/users` | Lista utenti |
| GET | `/api/admin/poll` | Request log |
| POST | `/api/admin/user/rank` | Cambia rank |
| POST | `/api/admin/user/username` | Cambia username |
| POST | `/api/admin/user/password` | Cambia password |
| POST | `/api/admin/user/suspend` | Sospendi/riattiva |
| POST | `/api/admin/user/ban` | Ban/unban |
| POST | `/api/admin/user/blacklist` | Blacklist |
| POST | `/api/admin/user/admin` | Set ruolo admin |
| POST | `/api/admin/user/unlock` | Sblocca account |
| POST | `/api/admin/user/delete` | Elimina utente |
| POST | `/api/admin/block-ip` | Blocca IP |
| POST | `/api/admin/unblock-ip` | Sblocca IP |

---

## ⚙️ Configurazione (`data/config.json`)

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "security": {
    "admin_panel_path": "/sv-ctrl-x7k9-mngmt-2025",
    "max_login_attempts": 5,
    "lockout_minutes": 15
  }
}
```

---

## 🔒 Come Accedere al Pannello Admin (Sicuro)

1. Apri il server: `python main.py`
2. Vai all'URL segreto mostrato nel terminale
3. Fai login con le credenziali admin
4. Salva l'URL in un posto sicuro — **non condividerlo mai**

> Il pannello non è linkato da nessuna parte del sito.
> Non appare in robots.txt, sitemap, o sorgente HTML pubblica.
> Cambia il path in `data/config.json` per massima sicurezza.
