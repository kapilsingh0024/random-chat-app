# Random Chat App

This repository contains a full-stack random chat application with:

- User app for signup/login, matching, live text/audio/video chat, reporting, and blocking
- Separate admin panel for moderation, user management, reports, and live session monitoring
- Express + Socket.IO backend with MongoDB persistence for accounts and reports only
- WebRTC peer-to-peer live media using Socket.IO signaling

## Project structure

```text
.
├── backend/
│   ├── src/
│   ├── .env.example
│   ├── package.json
│   └── server.js
├── userapp/
│   ├── src/
│   ├── .env.example
│   ├── package.json
│   └── vite.config.js
├── admin/
│   ├── src/
│   ├── .env.example
│   ├── package.json
│   └── vite.config.js
├── .gitignore
├── README.md
└── package.json
```

## Local development

### 1) Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

### 2) User app

```bash
cd userapp
cp .env.example .env
npm install
npm run dev
```

### 3) Admin app

```bash
cd admin
cp .env.example .env
npm install
npm run dev
```

### Default local URLS

- User app: http://localhost:5173
- Admin app: http://localhost:5174
- Backend health: http://localhost:5000/health

## Environment setup

Backend `.env` example:

```env
PORT=5000
JWT_SECRET=change_this_super_secret_key
MONGODB_URI=mongodb://127.0.0.1:27017/randomchat
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
ADMIN_EMAIL=admin@randomchat.local
ADMIN_PASSWORD=admin123
CLIENT_URL=http://localhost:5173
ADMIN_URL=http://localhost:5174
```

User app `.env`:

```env
VITE_API_URL=http://localhost:5000
VITE_TURN_SERVER=
VITE_TURN_USERNAME=
VITE_TURN_PASSWORD=
```

Admin app `.env`:

```env
VITE_API_URL=http://localhost:5000
VITE_ADMIN_TITLE=Random Chat Admin
```

## Production deployment on Render

The root `render.yaml` defines three separate Render services: the backend, user app, and admin app.

1. Push the repository to GitHub, then in Render choose **New +** > **Blueprint** and select this repository. Render reads `render.yaml` from the repository root.
2. Create a MongoDB Atlas database and database user. Set its network access to allow Render connections; Render's outbound IPs may change. Copy the Atlas connection string and replace its username and password with the database user's credentials.
3. During Blueprint creation, provide `MONGODB_URI`. The Blueprint configures the admin email and the two frontend origins. Render generates `JWT_SECRET` and `ADMIN_PASSWORD`; retrieve the admin password from the backend service's Environment settings and store it privately. Save the changes and deploy the backend.
4. Wait for the backend's `/health` endpoint to return `{"status":"ok"}`. Copy its `https://...onrender.com` URL.
5. The Blueprint automatically supplies the backend's `RENDER_EXTERNAL_URL` to both frontend builds as `VITE_API_URL`. No manual frontend URL setting is needed.
6. Confirm the admin service's URL is included in the backend's `ALLOWED_ORIGINS` value, and update/redeploy the backend if either frontend URL changes.

The admin login uses the `ADMIN_EMAIL` and `ADMIN_PASSWORD` values configured for the backend. Do not use the example local credentials in production. Audio/video calling may also need a TURN service for users behind restrictive networks; STUN alone is not sufficient for every network.

If a MongoDB URI or password was ever committed to Git or shared, rotate that database user's password before deployment. Never put production credentials in `.env.example` or commit a `.env` file.

## Privacy and moderation

This service provides temporary, live, peer-to-peer sessions. No chat content, voice, or video is stored in MongoDB or any persistent database. Sessions are kept only in memory while they are active. When a session ends, the session data is discarded. Reports and moderation actions may be retained for safety, abuse detection, and review. Admins may monitor or moderate reported or live sessions when required.

## Notes

- MongoDB is used only for user accounts and reports.
- Chat content is never written to the database.
- Admin accounts are separate from regular users and require dedicated credentials.

---

## Update notes (security + features)

**Nothing in `render.yaml` or any `package.json` changed**, so `npm ci` and your Render Blueprint keep working. Push to GitHub and Render redeploys on its own.

### What changed
- Chat is memory-only and is erased from the server AND the screen the moment a session ends (Next / Stop / partner leaves / admin ends / disconnect).
- User app: chat window with **Full screen** and **Mini screen** (floating window). In full screen the controls (Mute, Camera, **Next**, **Stop**, Report, Block) are always on screen.
- Only the two people inside a session can send chat or WebRTC signals or end it (before, any logged-in user could).
- **Next** now really finds a new person; Block is saved to the account and respected by matching.
- Reports: only the person you are chatting with, reason picker, optional "attach last messages" checkbox, 5 reports/hour.
- Admin: separate token secret, no default password in production, ban/unban/suspend/delete (real delete), password **reset link** (1 hour), live moderation updates, report resolve/dismiss, every admin view/action in the audit log.
- Rate limits on signup/login/admin login/API, match requests, chat messages; input validation; `trust proxy` for Render.

### Environment variables (Render dashboard -> backend -> Environment)
Already set by the blueprint: `MONGODB_URI`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ALLOWED_ORIGINS`.
Optional (nothing breaks if you skip them):
| Variable | Use |
|---|---|
| `ADMIN_JWT_SECRET` | separate secret for admin tokens (otherwise derived from `JWT_SECRET`) |
| `CLIENT_URL` | user-app URL used in password reset links (default: first `ALLOWED_ORIGINS` entry) |
| `STUN_URLS`, `TURN_URLS`, `TURN_SECRET` | time-limited TURN credentials served from `/api/ice` |

First admin login: email = `ADMIN_EMAIL`, password = the `ADMIN_PASSWORD` value shown in the Render dashboard. If an admin already exists in the DB it is not touched.
Old admin sessions stop working after this update: just log in again.

### TURN server (coturn) - needed for users behind strict NAT
```
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<same value as TURN_SECRET>
realm=turn.yourdomain.com
total-quota=100
no-multicast-peers
no-cli
cert=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem
```
Open ports 3478 (UDP/TCP), 5349 (TCP) and 49152-65535 (UDP). Then on the backend set
`TURN_URLS=turn:turn.yourdomain.com:3478?transport=udp,turns:turn.yourdomain.com:5349?transport=tcp` and `TURN_SECRET`.
(The older static `VITE_TURN_*` variables still work as a fallback.)

### Free Render note
The free backend sleeps when idle; the first request after a pause can take about 30-60 s. Live chat state is in memory, so a restart ends all running sessions (by design).
