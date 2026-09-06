import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const DEFAULT_TEST_RECIPIENT = "vishnutripathi.a@gmail.com";

const maskEmail = (email = "") => {
  const normalized = String(email).trim();
  return normalized
    ? normalized.replace(/^(.{2}).*(@.*)$/, "$1***$2")
    : "";
};

const recipient = String(process.argv[2] || DEFAULT_TEST_RECIPIENT).trim();

// Provider-agnostic on purpose. SMTP_* wins so a new provider (Titan, SES,
// Postmark) can be proven from this script alone, before any app code changes.
// Falling back to EMAIL/EMAIL_PASSWORD on Gmail keeps the existing behaviour,
// which is what src/ still hardcodes.
const host = String(process.env.SMTP_HOST || "smtp.gmail.com").trim();
const port = Number(process.env.SMTP_PORT || 465);
const secure =
  process.env.SMTP_SECURE !== undefined
    ? String(process.env.SMTP_SECURE).toLowerCase() === "true"
    : port === 465; // 465 is implicit TLS; 587 is STARTTLS and must be false
const sender = String(process.env.SMTP_USER || process.env.EMAIL || "").trim();
const password = String(process.env.SMTP_PASSWORD || process.env.EMAIL_PASSWORD || "");
const fromAddress = String(process.env.SMTP_FROM || sender).trim();
const fromName = String(process.env.SMTP_FROM_NAME || "Kitab Shop SMTP Test").trim();

const sentAt = new Date().toISOString();
const subject = `Kitab Shop SMTP diagnostic test - ${sentAt}`;

if (!sender || !password) {
  console.error("SMTP_SEND_FAILED");
  console.error(
    "Set SMTP_USER and SMTP_PASSWORD (or EMAIL and EMAIL_PASSWORD) in kitab-shop-be/.env",
  );
  process.exit(1);
}

if (!recipient) {
  console.error("SMTP_SEND_FAILED");
  console.error("Recipient email is required.");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user: sender, pass: password },
});

try {
  console.log(
    JSON.stringify(
      {
        action: "smtp_test_email",
        host,
        port,
        secure,
        from: maskEmail(fromAddress),
        to: maskEmail(recipient),
        subject,
      },
      null,
      2,
    ),
  );

  await transporter.verify();

  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to: recipient,
    subject,
    text: [
      "This is a diagnostic email from the Kitab Shop backend SMTP configuration.",
      "",
      `Sent at: ${sentAt}`,
      `Sender: ${fromAddress} via ${host}:${port}`,
      `Recipient: ${recipient}`,
    ].join("\n"),
  });

  console.log(
    JSON.stringify(
      {
        status: "SMTP_SEND_OK",
        messageId: info.messageId,
        accepted: (info.accepted || []).map(maskEmail),
        rejected: (info.rejected || []).map(maskEmail),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("SMTP_SEND_FAILED");
  console.error(
    JSON.stringify(
      {
        code: error.code,
        responseCode: error.responseCode,
        command: error.command,
        response: error.response,
        message: error.message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
