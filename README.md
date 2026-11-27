# RUA HOME Sales catalogue pilot

Run with Node.js 24 and `npm start`. The server listens on port 3000 locally.
On Render use a Node Web Service in Singapore, build command `npm install`,
start command `npm start`, and health check path `/healthz`.

Set these values in the hosting service's secret environment settings.

- `RUA_PILOT_PASSWORD` is a random password of at least 24 characters. Sign in
  as `pilot`. Use the hosted HTTPS URL.
- `RUA_WP_USER` and `RUA_WP_APP_PASSWORD` are the dedicated, read-only
  WordPress bridge account credentials. The server sends authenticated GET
  requests to ruahome.in. Credentials stay on the server.

The pilot shows the matched WooCommerce catalogue and supports demo carts,
simulated OTP, and session-only orders. Enter fictional customer information.
The pilot sign-in is shared. Employee accounts, PostgreSQL order storage,
production pricing, WhatsApp/SMS OTP, accounting, and an Android APK are
pending. No write requests are sent to WooCommerce.
