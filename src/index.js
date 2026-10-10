import express from "express";
import dotenv from "dotenv";
import cros from "cors";
import helmet from "helmet";
import compression from "compression";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1", "0.0.0.0"]);

import db from "./database/mongo.db.js";
import { router as auth } from "./modules/auth/index.js";
import { router as categoryRoutes } from "./modules/categories/index.js";
import { router as productRoutes } from "./modules/products/index.js";
import { router as cartRoutes } from "./modules/cart/index.js";
import { router as inventory } from "./modules/inventory/index.js";
import { router as order } from "./modules/orders/index.js";
import checkoutSettingsRoutes from "./modules/orders/checkout-settings.routes.js";
import shiprocketSettingsRoutes from "./modules/shipping/shiprocket-settings.routes.js";
import { router as admin } from "./modules/admin/index.js";
import { router as coupon } from "./modules/coupons/index.js";
import banner from "./modules/banner/banner.routes.js";
import { router as review } from "./modules/reviews/index.js";
import policy from "./modules/policy/policy.routes.js";
import { router as returnRoutes } from "./modules/returns/index.js";
import { router as paymentRoutes } from "./modules/payments/index.js";
import homepageRoutes from "./modules/homepage/homepage.routes.js";
import referralRoutes from "./modules/referral/referral.routes.js";
import { router as analyticsRoutes } from "./modules/analytics/index.js";
import themeRoutes from "./modules/theme/theme.routes.js";
import contactRoutes from "./modules/contact/contact.routes.js";
import footerRoutes from "./modules/footer/footer.routes.js";
import aboutPageRoutes from "./modules/about-page/aboutPage.routes.js";
import { router as cmsRoutes } from "./modules/cms/index.js";
import festivalRoutes from "./modules/festival/festival.routes.js";
import seasonRoutes from "./modules/season/season.routes.js";
import newsletterRoutes from "./modules/newsletter/newsletter.routes.js";
import { router as seoRoutes } from "./modules/seo/index.js";
import { startStockReservationCleanup } from "./modules/inventory/stock-reservation-cleanup.service.js";
import { getHttpConfig } from "./config/features.config.js";
import {
	ensureUploadDirs,
	uploadsPublicPath,
	uploadsRoot,
} from "./config/storage.config.js";

import { router as userProfileRoutes } from "./modules/profiles/index.js";
import { router as geoRoutes } from "./modules/geo/index.js";
import wishlistRoutes from "./modules/wishlist/wishlist.routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

await db();
await ensureUploadDirs();
startStockReservationCleanup();

const app = express();
const httpConfig = getHttpConfig();

// Trust the platform proxy so req.ip is the real client address. Without this,
// every request behind Vercel/nginx shares one rate limit bucket.
app.set("trust proxy", 1);

if (httpConfig.securityHeadersEnabled) {
	app.use(
		helmet({
			// The API serves JSON and image files, never HTML, so a CSP here would
			// only constrain responses no browser renders. crossOriginResourcePolicy
			// must stay "cross-origin" or the frontend origin cannot load /uploads.
			contentSecurityPolicy: false,
			crossOriginResourcePolicy: { policy: "cross-origin" },
		})
	);
}

if (httpConfig.compressionEnabled) {
	app.use(compression());
}

app.use(
	express.json({
		limit: httpConfig.jsonBodyLimit,
		verify: (req, res, buffer) => {
			req.rawBody = buffer.toString("utf8");
		},
	})
);
// CORS_ALLOWED_ORIGINS is a comma-separated allowlist. When it is set, ONLY those
// origins are permitted; when it is empty the previous reflect-any-origin behaviour
// is kept so local and LAN development keeps working untouched.
//
// This has to be honoured here and not merely reported: the admin System Health
// panel reads the same variable, so leaving the middleware permissive while the
// panel read the variable would have shown a green "CORS restricted" tick over a
// server that still accepted every origin — worse than no check at all.
//
// It matters because `credentials: true` is set: with a reflected origin, any
// website a logged-in customer visits can call this API as them.
const corsAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

app.use(
	cros({
		origin: (origin, callback) => {
			// No Origin header: same-origin navigations, curl, health checks, and the
			// payment/courier webhooks. Never a browser cross-origin request, so
			// there is nothing to authorise.
			if (!origin) return callback(null, true);
			if (corsAllowedOrigins.length === 0) return callback(null, origin);
			if (corsAllowedOrigins.includes(origin)) return callback(null, origin);
			// Refused without throwing: an Error here becomes a 500, which reads like
			// an outage. Omitting the header lets the browser block it and keeps the
			// response honest.
			return callback(null, false);
		},
		credentials: true,
	})
);
// Uploaded images. Filenames carry a timestamp and are never rewritten in
// place, so they are safe to cache immutably.
app.use(
	uploadsPublicPath,
	express.static(uploadsRoot, {
		maxAge: "1y",
		immutable: true,
		index: false,
		fallthrough: false,
		dotfiles: "deny",
	}),
	// fallthrough:false rejects a missing file (404), and a traversal attempt or
	// dotfile (403). Without this the generic handler below would report all of
	// them as a 500, which reads as a server fault for what is a client error.
	(err, req, res, next) => {
		const status = err?.statusCode || err?.status;

		if (err?.code === "ENOENT" || status === 404) {
			return res.status(404).json({ message: "Image not found" });
		}

		if (status === 403) {
			return res.status(403).json({ message: "Forbidden" });
		}

		return next(err);
	}
);

app.get("/", (req, res) => {
	res.status(200).json({
		status: "ok",
		service: "Kitab Shop API",
		message: "Backend is running.",
	});
});

app.get("/health", (req, res) => {
	res.status(200).json({
		status: "ok",
		service: "Kitab Shop API",
	});
});

app.use("/api/v1/auth", auth);

app.use("/api/v1/user/profile", userProfileRoutes);

app.use("/api/v1/geo", geoRoutes);

app.use("/api/v1/category", categoryRoutes);

app.use("/api/v1/product", productRoutes);

app.use("/api/v1/cart", cartRoutes);

app.use("/api/v1/wishlist", wishlistRoutes);

app.use("/api/v1/inventory", inventory);
app.use("/api/v1/order", order);
app.use("/api/v1/checkout-settings", checkoutSettingsRoutes);
app.use("/api/v1/shipping/settings", shiprocketSettingsRoutes);
app.use("/api/v1/coupon", coupon);
app.use("/api/v1/banner", banner);
app.use("/api/v1/review", review);
app.use("/api/v1/policy", policy);
app.use("/api/v1/returns", returnRoutes);
app.use("/api/v1/payment", paymentRoutes);
app.use("/api/v1/admin", admin);
app.use("/api/v1/referral", referralRoutes);
app.use("/api/v1/analytics", analyticsRoutes);
app.use("/api/v1/homepage", homepageRoutes);
app.use("/api/v1/theme", themeRoutes);
app.use("/api/v1/contact", contactRoutes);
app.use("/api/v1/footer", footerRoutes);
app.use("/api/v1/about-page", aboutPageRoutes);
app.use("/api/v1/cms", cmsRoutes);
app.use("/api/v1/festival", festivalRoutes);
app.use("/api/v1/season", seasonRoutes);
app.use("/api/v1/newsletter", newsletterRoutes);
app.use("/api/v1/seo", seoRoutes);

app.use((err, req, res, next) => {
	if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
		return res.status(400).json({ message: "Request body contains invalid JSON" });
	}

	console.error("Unhandled request error:", err);
	return res.status(500).json({ message: "Internal server error" });
});

const port = process.env.PORT || process.env.port || 3000;

app.listen(port, () =>
	console.log(`Server is running on port ${port}`)
);

export default app;
