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
VITE_TURN_SERVER=turn:turn.example.com:3478
VITE_TURN_USERNAME=demo
VITE_TURN_PASSWORD=demo123
```

Admin app `.env`:

```env
VITE_API_URL=http://localhost:5000
VITE_ADMIN_TITLE=Random Chat Admin
```

## Production deployment

### Backend
- Deploy to Render, Railway, Fly.io, or a VPS
- Use MongoDB Atlas or an external MongoDB service
- Set CORS to include frontend and admin domains
- Keep JWT secret and admin credentials in environment variables

### Frontend
- Deploy user app to Vercel or Netlify
- Deploy admin app to a different host/domain
- Set `VITE_API_URL` to your backend URL

### TURN server
- Host coturn or a managed TURN service
- Add the TURN credentials to the user app environment as shown above

## Privacy and moderation

This service provides temporary, live, peer-to-peer sessions. No chat content, voice, or video is stored in MongoDB or any persistent database. Sessions are kept only in memory while they are active. When a session ends, the session data is discarded. Reports and moderation actions may be retained for safety, abuse detection, and review. Admins may monitor or moderate reported or live sessions when required.

## Notes

- MongoDB is used only for user accounts and reports.
- Chat content is never written to the database.
- Admin accounts are separate from regular users and require dedicated credentials.
