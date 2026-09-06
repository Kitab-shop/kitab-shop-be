# Kitab Shop Backend

Node.js and Express API for Kitab Shop. It powers authentication, products, categories, cart, checkout pricing, Razorpay payment flow, orders, returns, reviews, referrals, admin settings, uploads, shipping integrations, and transactional emails.

## Tech Stack

- Node.js with ES modules
- Express
- MongoDB with Mongoose
- Zod validation
- Nodemailer for Gmail SMTP
- Razorpay integration
- Multer and Sharp for image uploads
- Redis optional for rate limiting/session-related infrastructure

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The API defaults to:

```text
http://localhost:3000
```

For LAN testing, expose the frontend and backend using the machine IP, for example:

```text
Backend:  http://172.16.3.105:3000
Frontend: http://172.16.3.105:5173
```

Railway sets `PORT` automatically. The server reads `PORT`, then falls back to local `port`.

## Environment

Keep real secrets only in `.env`. Do not commit `.env` or `.env.production`.

Important variables:

```env
NODE_ENV=production
PORT=3000
port=3000
mango_url=mongodb://...
SECRET_KEY=...

EMAIL=info.kitabshop@gmail.com
EMAIL_PASSWORD=gmail_app_password
FRONTEND_URL=http://localhost:5173
CORS_ALLOWED_ORIGINS=http://localhost:5173

RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
PAYMENTS_ENABLED=false
PAYMENT_PROVIDER=razorpay
PAYMENT_MODE=demo

UPLOADS_DIR=
AUTH_SECURITY_ENABLED=false
REFRESH_TOKEN_COOKIE_ENABLED=true
RATE_LIMIT_STORE=memory
REDIS_URL=
```

`FRONTEND_URL` is used inside verification and reset email links. For LAN demo, set it to the frontend URL users can actually open, for example:

```env
FRONTEND_URL=http://172.16.3.105:5173
```

In production, set `FRONTEND_URL` and `CORS_ALLOWED_ORIGINS` to the deployed frontend URL.

## Available Scripts

```bash
npm run dev                         # Start backend with nodemon
npm start                           # Start backend with node
npm test                            # Run full regression suite
npm run test:lifecycle              # Run lifecycle regression tests
npm run test:money                  # Run money/pricing regression tests
npm run test:security               # Run security regression tests
npm run test:smtp                   # Send a standalone SMTP diagnostic email
npm run admin:upsert                # Create or update an admin user
npm run db:backup                   # Create MongoDB backup archive
npm run db:restore                  # Restore MongoDB backup archive
npm run assets:static               # Fetch/static image assets
```

There are also focused regression scripts for inventory, returns, shipping, Razorpay amount guard, coupons, refunds, and fulfillment in `package.json`.

## Railway Deployment

This backend is Railway-ready with:

```text
railway.json
npm start
/health
process.env.PORT
```

Deploy checklist:

1. Push `kitab-shop-be` to GitHub, or connect the parent repository and set Railway service root directory to `kitab-shop-be`.
2. In Railway, create a new service from the backend repo.
3. Confirm build uses Nixpacks.
4. Confirm start command is `npm start`.
5. Add the required environment variables in Railway Variables. Do not upload `.env`.
6. Generate a public Railway domain from service Networking.
7. Set frontend `VITE_BACKEND_URL` to the Railway backend URL.
8. Set backend `FRONTEND_URL` and `CORS_ALLOWED_ORIGINS` to the deployed frontend URL.
9. Open `https://your-backend.up.railway.app/health` and confirm it returns `{"status":"ok"}`.

Minimum Railway variables:

```env
NODE_ENV=production
SECRET_KEY=replace_me
mango_url=mongodb+srv://...
FRONTEND_URL=https://your-frontend-domain
CORS_ALLOWED_ORIGINS=https://your-frontend-domain
EMAIL=info.kitabshop@gmail.com
EMAIL_PASSWORD=gmail_app_password
PAYMENTS_ENABLED=false
PAYMENT_PROVIDER=razorpay
PAYMENT_MODE=demo
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
AUTH_SECURITY_ENABLED=true
REFRESH_TOKEN_COOKIE_ENABLED=true
RATE_LIMIT_STORE=memory
```

Do not set `PORT` manually in Railway unless you have a specific reason. Railway injects it.

Uploads warning: Railway deploy storage is not a permanent image store unless you attach a volume. For product/category/banner uploads, attach a Railway volume and set:

```env
UPLOADS_DIR=/data/uploads
```

Without a persistent volume, uploaded images can disappear after redeploys.

## Render Deployment

This backend also includes a Render blueprint:

```text
render.yaml
npm start
/health
process.env.PORT
```

Deploy checklist:

1. Push `kitab-shop-be` to GitHub, or connect the parent repository and set Render root directory to `kitab-shop-be`.
2. Create a Render Web Service or use the `render.yaml` blueprint.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Health check path: `/health`.
6. Add environment variables in Render. Do not upload `.env`.
7. Set frontend `VITE_BACKEND_URL` to the Render backend URL.
8. Set backend `FRONTEND_URL` and `CORS_ALLOWED_ORIGINS` to the deployed frontend URL.
9. Open `https://your-backend.onrender.com/health` and confirm it returns `{"status":"ok"}`.

Minimum Render variables:

```env
NODE_ENV=production
SECRET_KEY=replace_me
mango_url=mongodb+srv://...
FRONTEND_URL=https://kitab-shop-fe.vercel.app
CORS_ALLOWED_ORIGINS=https://kitab-shop-fe.vercel.app
EMAIL=info.kitabshop@gmail.com
EMAIL_PASSWORD=gmail_app_password
PAYMENTS_ENABLED=false
PAYMENT_PROVIDER=razorpay
PAYMENT_MODE=demo
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
AUTH_SECURITY_ENABLED=true
REFRESH_TOKEN_COOKIE_ENABLED=true
RATE_LIMIT_STORE=memory
```

Do not set `PORT` manually in Render. Render injects it.

Render free-tier sleep warning: Free web services spin down after idle time. The `/health` endpoint lets Render check deploy health, but it does not guarantee the service stays awake for client demos. For a reliable demo, use one of these:

- Best: upgrade the Render service to a paid instance for the demo window.
- Demo workaround: create an external uptime ping to `https://your-backend.onrender.com/health` every 5-10 minutes using a service such as cron-job.org or UptimeRobot.

Do not add an internal cron/self-ping inside this Node app for sleep prevention. Once the Render service sleeps, in-process cron code is also asleep and cannot wake it.

## SMTP Email Test

The backend includes a standalone SMTP diagnostic script:

```bash
npm run test:smtp
```

Send to a specific recipient:

```bash
node scripts/test-smtp-email.js user@example.com
```

The script reads `EMAIL` and `EMAIL_PASSWORD` from `.env`, verifies Gmail SMTP, and sends a timestamped test email. It masks email addresses in console output.

Use a Gmail App Password, not the normal Gmail account password.

## Main API Areas

```text
src/modules/auth/          Signup, login, refresh token, email verification, 2FA
src/modules/products/      Product CRUD, gallery images, pricing fields
src/modules/category/      Category management
src/modules/cart/          Cart operations
src/modules/orders/        Checkout pricing preview, order placement, order state
src/modules/coupons/       Coupons and discount rules
src/modules/referral/      Referral settings, referral codes, wallet rewards
src/modules/reviews/       Product reviews and admin moderation
src/modules/returns/       Return and refund workflows
src/modules/shipping/      Shiprocket and shipping capabilities
src/modules/admin/         Admin health, settings, permissions, dashboards
```

## Email Verification Flow

- New signup creates an unverified account and sends the user to `/verify-email`.
- Login is blocked for unverified users and returns `code: "EMAIL_NOT_VERIFIED"`.
- Signup with an existing unverified email also returns `code: "EMAIL_NOT_VERIFIED"`.
- Signup with an already verified email returns the normal account-exists error.
- The frontend reuses `/verify-email` for all unverified account cases.
- Resend verification returns `502` only if mail sending fails.

If SMTP sends successfully but the email is not visible, check Gmail Spam, Promotions, Updates, and All Mail. `SMTP_SEND_OK` means Gmail accepted the message, not that it landed in the Primary inbox.

## Checkout And Payments

Checkout totals must come from the backend pricing preview/order APIs. The frontend should not independently calculate the final Razorpay amount.

Key points:

- Backend validates product prices, discounts, tax, shipping, coupons, and payable total.
- Razorpay payment intent/order amount must match the backend-calculated payable amount.
- `PAYMENTS_ENABLED=false` keeps payment behavior in demo/safe mode.
- Use `npm run test:intent-amount-guard` and `npm run test:money` after payment or pricing changes.

## Uploads And Backups

Uploaded files are runtime data and are ignored by Git:

```text
uploads/
backups/
*.archive.gz
```

MongoDB backups do not include disk uploads. Back up `uploads/` separately or point `UPLOADS_DIR` to a persistent mounted volume in production.

## Git Hygiene

Do not commit:

- `.env`
- `.env.production`
- Gmail app passwords
- Razorpay secrets
- MongoDB connection strings
- `node_modules/`
- `uploads/`
- `backups/`
- log files

If a secret was pasted into code or chat, rotate it before production use.
