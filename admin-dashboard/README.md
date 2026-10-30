# BTMS Super Admin Dashboard

This is a standalone static HTML, CSS, and JavaScript dashboard. It does not need
a Node.js build step and is published from this directory by
`.github/workflows/deploy-admin-dashboard.yml`.

## GitHub Pages

1. Ensure GitHub Pages is allowed for the repository by its owner or organization.
   The workflow enables Pages and selects GitHub Actions on its first run.
2. Push the dashboard and workflow to `main`, or run **Deploy BTMS admin
   dashboard** from the **Actions** tab.
3. Open `https://rajvenkadam.github.io/BTS_KIOT/`.

If the first run still reports that Pages cannot be enabled, open the repository's
**Settings → Pages**, select **GitHub Actions** as the build and deployment
source, save, and rerun the workflow. Organization policy may require an owner
to enable Pages first.

The workflow publishes only `admin-dashboard/` as the Pages site.

## Backend connection

`config.js` contains the production API base URL:

```js
window.BTMS_CONFIG = {
  API_BASE_URL: "https://bts-kiot.onrender.com",
};
```

Change that value if the BTMS API is deployed at another URL. The backend
allows the repository's GitHub Pages origin by default. For a custom Pages
domain, add its origin (scheme and hostname, without a path) to the backend's
comma-separated `CORS_ORIGIN` environment variable.

When testing this dashboard locally with VS Code Live Server at
`http://127.0.0.1:5500`, add that exact origin to the Render backend's
`CORS_ORIGIN` environment variable. For example:

```text
https://rajvenkadam.github.io,http://127.0.0.1:5500
```

In Render, open the backend service's **Environment** settings, set or update
`CORS_ORIGIN`, and save the change so the service redeploys. Origins must match
the browser address exactly, but must not include a path such as
`/admin-dashboard/index.html`. Remove the local origin from `CORS_ORIGIN` when
local testing is finished.

Admin sessions use `sessionStorage` and are cleared when the browser tab session
ends or the administrator signs out. All administrative operations are still
authorized by the backend; publishing the static files does not grant API
access.
