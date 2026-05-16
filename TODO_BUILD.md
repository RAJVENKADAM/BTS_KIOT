# TODO_BUILD

## Production readiness (backend)
1. Add Helmet + basic rate limiting + tighten CORS (via `CORS_ORIGIN`) + global error handler in `backend/src/app.js`.
2. Add required dependencies to `backend/package.json`.
3. Update Render environment variable checklist (NODE_ENV, CORS_ORIGIN, DB creds, JWT_SECRET, email/Firebase vars).
4. Redeploy backend on Render.
5. Verify `/health` works and frontend can still connect to APIs/Socket.IO.

