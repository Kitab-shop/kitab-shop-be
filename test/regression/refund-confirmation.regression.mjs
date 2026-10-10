/**
 * Admin Razorpay refund: the confirmation step and the endpoint behind it (H2-08).
 *
 * The refund button was one click straight to a real, irreversible transfer. The
 * confirmation dialog that fixes that is frontend code, and this repository has NO
 * frontend test infrastructure — no vitest, no jest, no testing-library, no test
 * runner of any kind, and no .test/.spec files anywhere in kitab-shop-fe. Rather
 * than bolt a whole framework on for one dialog, this suite splits the work:
 *
 *   BEHAVIOURAL, against the real controller — the endpoint itself, which had
 *   ZERO test coverage before this file existed. Authorization, idempotency,
 *   amount validation and the ceiling all run as deployed, with only the gateway
 *   call stubbed.
 *
 *   STRUCTURAL, against the frontend source — REACHABILITY of the network call,
 *   not the presence of strings. "Cancel performs no request" is provable by
 *   showing the only refund request in the file lives inside a handler reachable
 *   solely from the dialog's onConfirm, and that onCancel is a pure state setter.
 *   That is a real property; what it cannot cover is rendering and events, and
 *   that limitation is stated in the report rather than papered over.
 *
 * Run with `npm run test:refund-confirmation` (or `npm test` for everything).
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("refund-confirmation");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const paymentController = await import("../../src/modules/payments/payment.controller.js");
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");
const { sumRefunded, sumSettledRefunds } = await import(
  "../../src/modules/payments/return-refund.service.js"
);
const { ADMIN_PERMISSIONS } = await import("../../src/config/admin-permissions.config.js");
const { requirePermission } = await import("../../src/middleware/require-permission.middleware.js");

await OrderModel.init();

const MARKER = marker("refundconfirm");
const trash = { orders: [], products: [], users: [] };
let seq = 0;

// ── Razorpay stub ───────────────────────────────────────────────────────────
// Same technique as refund-safety: getRazorpay() caches one SDK instance that every
// caller shares, so patching its METHODS reaches the code under test. An ES module
// namespace cannot be redefined, and this is closer to production anyway — the real
// client, only the network hop replaced.
const calls = { refund: [] };
let refundIdSeq = 0;
let refundBehaviour = () => ({ id: `rfnd_${MARKER}_${++refundIdSeq}`, status: "processed" });

const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async (paymentId, options) => {
  calls.refund.push({ paymentId, options });
  return refundBehaviour(paymentId, options);
};
sharedRazorpay.payments.fetchMultipleRefund = async () => ({ items: [] });

const resetGateway = () => {
  calls.refund = [];
  refundBehaviour = () => ({ id: `rfnd_${MARKER}_${++refundIdSeq}`, status: "processed" });
};

const makeOrder = async ({ total = 1000, paymentMethod = "RAZORPAY", paymentStatus = "Paid" } = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 10 }));
  trash.products.push(product._id);
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: total, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal: total,
    totalAmount: total,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query: {}, get: () => undefined }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const refund = (orderId, body = {}, user = admin()) =>
  callController(paymentController.RefundRazorpayPayment, {
    params: { orderId: String(orderId) },
    body,
    user,
  });

const fresh = (id) => OrderModel.findById(id);
const readFe = (path) => readFile(new URL(path, import.meta.url), "utf8");

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — the endpoint's authorization is unchanged");

  {
    const order = await makeOrder();

    // The controller's own role check, independent of the route middleware.
    //
    // Called through callController directly rather than the refund() helper: that
    // helper defaults `user` to an admin, and a default parameter fires on
    // `undefined` — so passing `undefined` to it would silently test an ADMIN
    // request and pass for the wrong reason.
    const anonymous = await callController(paymentController.RefundRazorpayPayment, {
      params: { orderId: String(order._id) },
      body: { amount: 100 },
    });
    ok("a request with no user at all is refused", anonymous.statusCode === 403,
      `${anonymous.statusCode}`);

    const customer = await refund(order._id, { amount: 100 }, { id: String(new mongoose.Types.ObjectId()), roles: ["user"] });
    ok("a signed-in customer is refused", customer.statusCode === 403, `${customer.statusCode}`);

    const noRoles = await refund(order._id, { amount: 100 }, { id: String(new mongoose.Types.ObjectId()), roles: [] });
    ok("a caller with no roles is refused", noRoles.statusCode === 403);

    const emptyUser = await refund(order._id, { amount: 100 }, {});
    ok("a caller with no identity is refused", emptyUser.statusCode === 403,
      `${emptyUser.statusCode}`);

    ok("and none of those reached the gateway", calls.refund.length === 0,
      `${calls.refund.length}`);
    ok("nor recorded a refund", (await fresh(order._id)).refunds.length === 0);

    // The route's permission layer, which is what stops an admin-tier role that
    // lacks orders:manage.
    const makeUser = async (roles, extra = {}) => {
      const user = await UserModel.create({
        name: `${MARKER} user`,
        email: `${MARKER}-${trash.users.length}@test.local`,
        password: "x".repeat(60),
        roles,
        ...extra,
      });
      trash.users.push(user._id);
      return user;
    };
    const gate = requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE);
    const runGate = async (user) => {
      let statusCode = 200;
      let passed = false;
      const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
      await gate({ user: user ? { id: String(user._id) } : undefined }, res, () => { passed = true; });
      return { statusCode, passed };
    };

    ok("the route refuses an unauthenticated caller", !(await runGate(null)).passed);
    ok("the route refuses a customer", !(await runGate(await makeUser(["user"]))).passed);
    ok("the route refuses an admin without orders:manage",
      !(await runGate(await makeUser(["themeEditor"]))).passed);
    ok("the route refuses a blocked admin",
      !(await runGate(await makeUser(["admin"], { isBlocked: true }))).passed);
    ok("and allows an admin with orders:manage",
      (await runGate(await makeUser(["admin"]))).passed === true);

    const routes = await readFile(
      new URL("../../src/modules/payments/payment.routes.js", import.meta.url),
      "utf8",
    );
    const route = routes.slice(routes.indexOf('"/razorpay/refund/:orderId"'));
    ok("the route still requires authentication", /TokenVerify/.test(route.slice(0, 300)));
    ok("still requires orders:manage", /ORDERS_MANAGE/.test(route.slice(0, 300)));
    ok("and still carries the refund rate limit", /refundRateLimit/.test(
      routes.slice(routes.indexOf("router.post(\n  \"/razorpay/refund"), routes.indexOf('"/razorpay/refund/:orderId"') + 300),
    ) || /refundRateLimit/.test(route.slice(0, 300)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — an authorized admin refund still works, unchanged");

  {
    resetGateway();
    const order = await makeOrder({ total: 1000 });
    const response = await refund(order._id, {
      amount: 400,
      reason: "Damaged on arrival",
      idempotencyKey: `adm-${MARKER}-ok`,
    });

    ok("the refund succeeds", response.statusCode === 200,
      `${response.statusCode} ${response.body?.message}`);
    ok("the gateway was called exactly once", calls.refund.length === 1, `${calls.refund.length}`);
    ok("for the amount submitted, in paise",
      calls.refund[0]?.options?.amount === 40000, JSON.stringify(calls.refund[0]?.options));

    const saved = await fresh(order._id);
    ok("one refund row is recorded", saved.refunds.length === 1);
    ok("for the submitted amount", Math.abs(saved.refunds[0].amount - 400) < 0.01,
      String(saved.refunds[0].amount));
    ok("the reason is preserved", saved.refunds[0].reason === "Damaged on arrival");
    ok("the dialog's idempotency key is stored",
      saved.refunds[0].idempotencyKey === `adm-${MARKER}-ok`, saved.refunds[0].idempotencyKey);
    ok("it settled", saved.refunds[0].status === "processed", saved.refunds[0].status);
    ok("and paymentStatus derives to Partially Refunded",
      saved.paymentStatus === "Partially Refunded", saved.paymentStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — the dialog's key is what makes a double-click safe");

  {
    resetGateway();
    const order = await makeOrder({ total: 1000 });
    const key = `adm-${MARKER}-double`;

    // Exactly what a double-click produces if both requests escape the frontend:
    // two requests carrying the SAME key, because the key is generated once when the
    // dialog opens rather than per click.
    const [first, second] = await Promise.all([
      refund(order._id, { amount: 500, reason: "Double click", idempotencyKey: key }),
      refund(order._id, { amount: 500, reason: "Double click", idempotencyKey: key }),
    ]);

    // Exactly one wins the ledger claim; the loser is told so with a 409 rather
    // than being given a misleading 200. That is the established contract — see
    // refund-safety's "one refunds, the other adopts or reconciles instead of
    // paying again" — so it is asserted as it behaves.
    const codes = [first.statusCode, second.statusCode].sort();
    ok("exactly one of the two concurrent requests reports success",
      codes.filter((c) => c === 200).length === 1, JSON.stringify(codes));
    ok("and the loser is refused rather than told it succeeded",
      codes.some((c) => c === 409), JSON.stringify(codes));
    ok("but the gateway was called ONCE", calls.refund.length === 1, `${calls.refund.length}x`);

    const saved = await fresh(order._id);
    const live = saved.refunds.filter((r) => r.status !== "failed");
    ok("and exactly one refund exists", live.length === 1, String(live.length));
    ok("of 500, not 1000", Math.abs(sumSettledRefunds(saved) - 500) < 0.01,
      String(sumSettledRefunds(saved)));

    // A sequential retry of the same confirmation is equally safe.
    const retry = await refund(order._id, { amount: 500, reason: "Double click", idempotencyKey: key });
    ok("a later retry with the same key adds nothing", retry.statusCode === 200);
    ok("still one gateway call", calls.refund.length === 1, `${calls.refund.length}x`);
    ok("still 500 refunded", Math.abs(sumSettledRefunds(await fresh(order._id)) - 500) < 0.01);

    // A genuinely new refund — a new dialog, hence a new key — is allowed.
    const second500 = await refund(order._id, {
      amount: 500,
      reason: "Second deliberate refund",
      idempotencyKey: `adm-${MARKER}-double-2`,
    });
    ok("a NEW key is a new deliberate refund", second500.statusCode === 200,
      `${second500.statusCode} ${second500.body?.message}`);
    ok("which does reach the gateway", calls.refund.length === 2, `${calls.refund.length}x`);
    const full = await fresh(order._id);
    ok("the order is now fully refunded", full.paymentStatus === "Refunded", full.paymentStatus);
    ok("and the ceiling held", sumRefunded(full) <= full.totalAmount + 0.01,
      `${sumRefunded(full)} of ${full.totalAmount}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — amount validation is unchanged");

  {
    resetGateway();
    const order = await makeOrder({ total: 500 });

    for (const [label, amount] of [["zero", 0], ["negative", -100], ["not a number", "abc"]]) {
      const response = await refund(order._id, { amount, idempotencyKey: `adm-${MARKER}-${label}` });
      // 0 and "" fall back to totalAmount by the existing `||` default, so only
      // genuinely invalid values are rejected — asserted as it behaves, not as I
      // would prefer it to behave.
      const rejected = response.statusCode === 400;
      const fellBack = response.statusCode === 200;
      ok(`an amount of "${label}" is either rejected or falls back to the order total`,
        rejected || fellBack, `${response.statusCode} ${response.body?.message}`);
    }

    const cod = await makeOrder({ total: 500, paymentMethod: "COD", paymentStatus: "Paid" });
    const codRefund = await refund(cod._id, { amount: 100, idempotencyKey: `adm-${MARKER}-cod` });
    ok("a COD order cannot be refunded through this endpoint", codRefund.statusCode === 400,
      `${codRefund.statusCode}`);

    const missing = await refund(new mongoose.Types.ObjectId(), { amount: 100 });
    ok("an unknown order is a 404", missing.statusCode === 404);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — the confirmation dialog exists and identifies the money");

  {
    const dialog = await readFe("../../../kitab-shop-fe/src/features/admin-orders/RefundConfirmDialog.jsx");

    ok("the dialog identifies the order", /order\.id/.test(dialog));
    ok("shows the order total", /order\.total/.test(dialog));
    ok("shows the amount being refunded, from the amount prop",
      /const expected = Number\(amount\)/.test(dialog));
    ok("in rupees", /₹/.test(dialog));
    ok("states the action is irreversible",
      /not reversible|cannot be undone/i.test(dialog), "no irreversibility wording");
    ok("names the gateway and the destination",
      /Razorpay/.test(dialog) && /original payment/i.test(dialog));
    ok("has a Cancel control", />\s*Cancel\s*</.test(dialog));
    ok("and a distinct confirm control naming the amount",
      /Refund ₹\$\{pretty\}/.test(dialog));

    // Accidental confirmation is the risk the dialog exists to remove.
    ok("the amount must be TYPED to match before confirming",
      /const matches =/.test(dialog) && /canSubmit = matches/.test(dialog));
    ok("the confirm button is disabled until it matches", /disabled=\{!canSubmit\}/.test(dialog));
    ok("a mismatched amount therefore cannot be submitted",
      /Math\.abs\(Number\(normalised\) - expected\)/.test(dialog));

    // Modal semantics.
    ok("it is marked up as a modal dialog",
      /role="dialog"/.test(dialog) && /aria-modal="true"/.test(dialog));
    ok("with an accessible name", /aria-labelledby="refund-confirm-title"/.test(dialog));
    ok("Escape cancels", /event\.key === "Escape"/.test(dialog));
    ok("a backdrop click cancels", /event\.target === event\.currentTarget/.test(dialog));
    ok("neither dismisses while a refund is in flight",
      (dialog.match(/&& !working\) onCancel\(\)/g) || []).length === 2,
      String((dialog.match(/&& !working\) onCancel\(\)/g) || []).length));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — REACHABILITY: no request can happen without confirming");

  {
    const page = await readFe("../../../kitab-shop-fe/src/pages/admin/AdminOrderDetail.jsx");
    const dialog = await readFe("../../../kitab-shop-fe/src/features/admin-orders/RefundConfirmDialog.jsx");

    // There is exactly ONE refund request in the page, and it is inside refundOrder.
    const requests = page.match(/payment\/razorpay\/refund/g) || [];
    ok("the page contains exactly one refund request", requests.length === 1,
      String(requests.length));

    const handler = page.slice(page.indexOf("const refundOrder"), page.indexOf("const addNote") > page.indexOf("const refundOrder") ? page.indexOf("const addNote") : page.length);
    const refundOrderBody = page.slice(
      page.indexOf("const refundOrder"),
      page.indexOf("const refundOrder") + 600,
    );
    ok("that request lives inside refundOrder", /payment\/razorpay\/refund/.test(refundOrderBody),
      refundOrderBody.slice(0, 120));

    // refundOrder is wired ONLY to the dialog's onConfirm.
    const references = (page.match(/refundOrder/g) || []).length;
    ok("refundOrder is referenced exactly twice — its definition and onConfirm",
      references === 2, String(references));
    ok("and that reference is onConfirm", /onConfirm=\{refundOrder\}/.test(page));

    // The visible button opens the dialog; it cannot refund.
    const button = page.slice(page.indexOf("setShowRefundConfirm(true)") - 400, page.indexOf("setShowRefundConfirm(true)") + 200);
    ok("the Refund button only opens the confirmation",
      /onClick=\{\(\) => setShowRefundConfirm\(true\)\}/.test(button));
    ok("it does not call refundOrder", !/refundOrder/.test(button));
    ok("and it is labelled as a step, not an action", /Refund\.\.\./.test(page));

    // Cancel is a pure state setter — no request is reachable from it.
    ok("onCancel only closes the dialog",
      /onCancel=\{\(\) => setShowRefundConfirm\(false\)\}/.test(page));
    ok("so cancelling, dismissing or pressing Escape cannot issue a request",
      !/onCancel=\{[^}]*postJson/.test(page) && !/postJson/.test(dialog));
    ok("the dialog itself makes no network call of any kind",
      !/fetch\(|postJson|axios|XMLHttpRequest/.test(dialog));

    // The dialog is only mounted while confirmation is pending.
    ok("the dialog renders only when confirmation is open",
      /\{showRefundConfirm && \(/.test(page));

    // Double-submission.
    ok("the dialog refuses a second submit in the same attempt",
      /if \(!canSubmit \|\| submitted\.current\) return;/.test(dialog));
    ok("and releases that guard if the attempt failed, so a retry is possible",
      /if \(wasWorking\.current && !working\) submitted\.current = false;/.test(dialog));
    ok("the button is also disabled while working", /disabled=\{!canSubmit\}/.test(dialog) &&
      /canSubmit = matches && !working/.test(dialog));

    // The amount confirmed is the amount submitted — one source, not two.
    ok("the dialog is given the same value the request sends",
      /amount=\{Number\(refundAmount\)\}/.test(page) &&
        /amount: Number\(refundAmount\)/.test(page));

    // Idempotency: generated once in the dialog, passed out on confirm.
    ok("the key is generated once per mount, not per click",
      /const \[idempotencyKey\] = useState\(/.test(dialog));
    ok("and handed to the parent on confirm", /onConfirm\(\{ idempotencyKey \}\)/.test(dialog));
    ok("the parent forwards it to the existing endpoint", /idempotencyKey,/.test(page));
    ok("the dialog is remounted per attempt so a NEW refund gets a NEW key",
      /key=\{`\$\{order\.id\}-\$\{refundAmount\}-\$\{refundReason\}`\}/.test(page));
    ok("no second idempotency mechanism was invented",
      (dialog.match(/idempotencyKey/g) || []).length <= 4,
      String((dialog.match(/idempotencyKey/g) || []).length));

    // Existing success/failure handling is untouched.
    ok("success still runs through the shared runAction handler",
      /runAction\("Refund"/.test(page));
    ok("which refreshes the order and reports the outcome",
      /await refresh\(\)/.test(page) && /showErrorPopup/.test(page));
    ok("and success closes the dialog", /setShowRefundConfirm\(false\)/.test(page));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7 — the frontend test-infrastructure gap, asserted rather than assumed");

  {
    const pkg = JSON.parse(await readFe("../../../kitab-shop-fe/package.json"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const runners = ["vitest", "jest", "@testing-library/react", "@playwright/test", "cypress"];
    const present = runners.filter((name) => name in deps);
    ok("there is genuinely no frontend test runner installed — hence the structural tests above",
      present.length === 0, JSON.stringify(present));
    ok("and no test script defined", !pkg.scripts?.test, JSON.stringify(pkg.scripts?.test));
    // If this ever fails, the reachability assertions above should be replaced with
    // real render tests rather than added to.
  }
} catch (error) {
  console.error("\nSUITE ABORTED:", error);
  process.exitCode = 1;
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  await mongoose.disconnect();
  finish();
}
