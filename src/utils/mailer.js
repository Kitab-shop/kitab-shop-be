/**
 * The one SMTP transport for the whole app, with a Gmail fallback.
 *
 * Four modules used to build their own nodemailer transport with
 * smtp.gmail.com hardcoded, disagreeing on port (two on 587, two on 465), so
 * "email works" depended on which email it was.
 *
 * Config, SMTP_* first so a provider swap is env-only:
 *   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASSWORD
 *   SMTP_FROM / SMTP_FROM_NAME
 *
 * FALLBACK: if the primary fails at the transport level — bad credentials,
 * unreachable host, TLS failure — the message is retried through Gmail using
 * EMAIL/EMAIL_PASSWORD. A provider that is not fully provisioned yet must not
 * mean a customer gets no order confirmation.
 */
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const str = (value, fallback = "") => String(value ?? "").trim() || fallback;

// 465 is implicit TLS; 587 is STARTTLS and must be secure:false or the
// connection hangs until it times out. Derived from the port so that is not a
// per-provider footgun, while SMTP_SECURE still wins when set.
const secureForPort = (port, explicit) =>
  explicit !== undefined && str(explicit) !== ""
    ? str(explicit).toLowerCase() === "true"
    : Number(port) === 465;

const GMAIL = { host: "smtp.gmail.com", port: 587 };

/** What SMTP_* asks for, falling back to Gmail when SMTP_* is unset. */
export const mailConfig = () => {
  const host = str(process.env.SMTP_HOST, GMAIL.host);
  const port = Number(process.env.SMTP_PORT) || (host === GMAIL.host ? GMAIL.port : 465);
  const explicitUser = str(process.env.SMTP_USER);
  const user = explicitUser || str(process.env.EMAIL);
  const pass = String(process.env.SMTP_PASSWORD || process.env.EMAIL_PASSWORD || "");

  // SMTP_FROM only applies when SMTP_USER supplied the account. Half-configured
  // otherwise — SMTP_USER commented out while SMTP_FROM is left set — would
  // have Gmail authenticate as one address and claim another, which it rejects
  // for a From it does not own.
  const from = explicitUser ? str(process.env.SMTP_FROM) || user : user;

  return {
    host,
    port,
    secure: secureForPort(port, process.env.SMTP_SECURE),
    user,
    pass,
    from,
    fromName: str(process.env.SMTP_FROM_NAME, "Rivermoss Books"),
    // Where customer replies land. Split from the sender on purpose: mail goes
    // out from the brand address, while "reply" reaches the inbox a human
    // actually watches. Defaults to the sender when unset.
    replyTo: str(process.env.SMTP_REPLY_TO) || from,
    configured: Boolean(user && pass),
  };
};

/**
 * Gmail, from EMAIL/EMAIL_PASSWORD. Null when unavailable, or when it IS the
 * primary — retrying the server that just refused us is pointless.
 */
const gmailFallbackConfig = () => {
  const user = str(process.env.EMAIL);
  const pass = String(process.env.EMAIL_PASSWORD || "");
  if (!user || !pass) return null;

  const primary = mailConfig();
  if (primary.host === GMAIL.host && primary.user === user) return null;

  return {
    ...GMAIL,
    secure: false,
    user,
    pass,
    // Keeps SMTP_FROM — the domain address — rather than exposing the Gmail
    // account, because that address is verified under "Send mail as" on this
    // Gmail account and Gmail therefore permits it. Customers see the right
    // sender even while the primary provider is down.
    //
    // NOTE ON DELIVERABILITY: the domain's SPF is `include:spf.titan.email`
    // only, so a message sent this way does not SPF-align. It still delivers
    // today because there is no DMARC policy. Add Google to the record —
    // `include:_spf.google.com` — if this fallback is meant to be more than
    // an emergency path, or add DMARC only after doing so.
    from: primary.from || user,
    fromName: str(process.env.SMTP_FROM_NAME, "Rivermoss Books"),
    replyTo: primary.replyTo || user,
    // The Gmail account address, used if Gmail refuses the From above.
    ownedFrom: user,
    configured: true,
  };
};

const transports = new Map();

const transportFor = (config) => {
  const key = `${config.host}:${config.port}:${config.user}`;
  if (!transports.has(key)) {
    transports.set(
      key,
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
      }),
    );
  }
  return transports.get(key);
};

// Transport-level failures only. Each happens BEFORE the server accepts the
// message, so a retry cannot duplicate a delivery. A rejection of the recipient
// itself (550, 553) is deliberately absent: Gmail would reject it too, and
// retrying would only produce a second bounce.
const RETRYABLE = new Set([
  "EAUTH",
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNREFUSED",
]);

const deliver = async (config, { to, subject, html, text, replyTo }) =>
  transportFor(config).sendMail({
    from: `"${config.fromName}" <${config.from}>`,
    replyTo: replyTo || config.replyTo || config.from,
    to,
    subject,
    text,
    html,
  });

/**
 * Send one message. Returns false when SMTP is unconfigured or the recipient is
 * missing, so a fire-and-forget caller cannot be broken by a missing config.
 * A failure with no usable fallback still throws — signup needs to know, having
 * previously told people to check an inbox for mail that was never sent.
 */
export const sendMail = async (message) => {
  const primary = mailConfig();

  if (!primary.configured) {
    console.warn("[mailer] SMTP is not configured — skipping:", message?.subject);
    return false;
  }
  if (!message?.to) return false;

  try {
    await deliver(primary, message);
    return true;
  } catch (error) {
    const fallback = RETRYABLE.has(error?.code) ? gmailFallbackConfig() : null;
    if (!fallback) throw error;

    console.warn(
      `[mailer] ${primary.host} failed (${error.code} ${error.responseCode || ""}) — retrying via ${fallback.host}`,
    );

    try {
      await deliver(fallback, message);
      console.warn(`[mailer] delivered via fallback as ${fallback.from}`);
    } catch (fallbackError) {
      // Gmail refuses a From it does not own, so an unverified "Send mail as"
      // alias fails here. Retrying with the account's own address is better
      // than sending nothing — a visibly wrong sender still beats silence.
      if (fallback.from === fallback.ownedFrom) throw fallbackError;
      console.warn(
        `[mailer] ${fallback.host} refused From ${fallback.from} (${fallbackError.responseCode || fallbackError.code}) — resending as ${fallback.ownedFrom}`,
      );
      await deliver({ ...fallback, from: fallback.ownedFrom }, message);
      console.warn(`[mailer] delivered via fallback as ${fallback.ownedFrom}`);
    }
    return true;
  }
};

/** For the SMTP diagnostic script and the admin health panel. */
export const verifyMailer = async () => {
  const primary = mailConfig();
  if (!primary.configured) throw new Error("SMTP is not configured");
  return transportFor(primary).verify();
};
