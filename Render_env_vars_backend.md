# Render environment variables - Backend (BTS)

Set these in Render for the backend service:

## Required
- `NODE_ENV=production`
- `PORT` (Render usually sets automatically; keep default fine)

### CORS
- `CORS_ORIGIN` = your frontend origin(s), comma-separated.
  - Example (web): `https://your-frontend-domain.com`
  - If you don’t have a web origin, set this to your app’s origin(s) actually calling the API.

### Database (MySQL)
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

### Auth
- `JWT_SECRET`

## If email notifications are used
- `EMAIL_USER`
- `EMAIL_PASS`

## If Firebase Admin is used (push notifications)
- Any vars required by `backend/firebase.js` (often service account JSON or keys)

