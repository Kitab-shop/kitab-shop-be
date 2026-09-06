/**
 * The one SMTP transport for the whole app.
 *
 * Four modules used to build their own nodemailer transport with
 * smtp.gmail.com hardcoded — and they disagreed with each other on port (two
 * on 587, two on 465), so "email works" depended on which email it was.
 * Changing provider meant editing four files, and the SMTP_* variables in
 * .env.example were read by nothing at all.
 *
 * Config, SMTP_* first so a provider swap is env-only:
 *
 *   SMTP_HOST       default smtp.gmail.com
 *   SMTP_PORT       default 587
 *   SMTP_SECURE     default: true only on 465
 *   SMTP_USER       falls back to EMAIL
 *   SMTP_PASSWORD   falls back to EMAIL_PASSWORD
 *   SMTP_FROM       falls back to the auth user
 *   SMTP_FROM_NAME  default "Rivermoss Books"
 *
 * The EMAIL/EMAIL_PASSWORD fallback exists so an existing deployment keeps
 * working after this change with no .env edit.
 */
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const str = (value, fallback = "") => String(value ?? "").trim() || fallback;

export const mailConfig = () => {
  const host = str(process.env.SMTP_HOST, "smtp.gmail.com");
  const port = Number(process.env.SMTP_PORT) || 587;
  // 465 is implicit TLS; 587 is STARTTLS and must be secure:false or the
  // connection hangs until it times out. Deriving it from the port stops that
  // being a per-provider footgun, while SMTP_SECURE still wins if set.
  const secure =
    process.env.SMTP_SECURE !== undefined && str(process.env.SMTP_SECURE) !== ""
      ? str(process.env.SMTP_SECURE).toLowerCase() === "true"
      : port === 465;

  const user = str(process.env.SMTP_USER) || str(process.env.EMAIL);
  const pass = String(process.env.SMTP_PASSWORD || process.env.EMAIL_PASSWORD || "");

  return {
    host,
    port,
    secure,
    user,
    pass,
    from: str(process.env.SMTP_FROM) || user,
    fromName: str(process.env.SMTP_FROM_NAME, "Rivermoss Books"),
    configured: Boolean(user && pass),
  };
};

let transporter;

/**
 * Built once and reused. The old code created a transport per email, so every
 * message paid for a fresh TLS handshake.
 */
const getTransporter = () => {
  const { host, port, secure, user, pass, configured } = mailConfig();
  if (!configured) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
  }
  return transporter;
};

/**
 * Send one message. Returns false rather than throwing when SMTP is not
 * configured or the recipient is missing, so a caller that treats email as
 * fire-and-forget cannot be broken by an unconfigured mailer.
 *
 * Delivery failures DO throw — the caller decides whether that matters.
 * Signup, for one, needs to know: it used to tell people to check their inbox
 * for a mail that was never sent.
 */
export const sendMail = async ({ to, subject, html, text, replyTo }) => {
  const { from, fromName } = mailConfig();
  const mailer = getTransporter();

  if (!mailer) {
    console.warn("[mailer] SMTP is not configured — skipping:", subject);
    return false;
  }
  if (!to) return false;

  await mailer.sendMail({
    from: `"${fromName}" <${from}>`,
    replyTo: replyTo || from,
    to,
    subject,
    text,
    html,
  });
  return true;
};

/** For the SMTP diagnostic script and the admin health panel. */
export const verifyMailer = async () => {
  const mailer = getTransporter();
  if (!mailer) throw new Error("SMTP is not configured");
  return mailer.verify();
};
