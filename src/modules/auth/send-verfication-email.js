import { sendMail } from "../../utils/mailer.js";
import dotenv from "dotenv";

dotenv.config();

export const SendVerficationEmail = async (email, token, otp) => {
  try {
    // Same normalisation as the password-reset link: a trailing slash on
    // FRONTEND_URL must not produce `https://site//verify-email`, and an unset
    // FRONTEND_URL must not send customers to `undefined/verify-email` — this had
    // no fallback at all, so a missing env var silently emailed a broken link.
    const frontendOrigin = String(process.env.FRONTEND_URL || "http://localhost:5173").replace(
      /\/+$/,
      "",
    );
    const verificationLink = `${frontendOrigin}/verify-email?token=${encodeURIComponent(token)}`;

    // Create HTML template directly to avoid Vercel filesystem issues
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Verify Email</title>
  </head>
  <body
    style="
      font-family: Arial, sans-serif;
      background: #f5f5f5;
      padding: 40px;
      text-align: center;
    "
  >
    <h2>Verify Your Email</h2>

    <p>Thank you for registering.</p>

    <p>Click the button below to verify your email.</p>

    <a
      href="${verificationLink}"
      style="
        display: inline-block;
        padding: 15px 30px;
        background: #2563eb;
        color: white;
        text-decoration: none;
        border-radius: 6px;
      "
    >
      Verify Email
    </a>

    <br /><br />

    <p>If the button doesn't work, copy this link:</p>

    <p>${verificationLink}</p>

    <br />

    <p>Or enter this code on the verification page:</p>

    <div
      style="
        display: inline-block;
        font-size: 32px;
        font-weight: bold;
        letter-spacing: 8px;
        padding: 12px 24px;
        background: #eef2ff;
        color: #2563eb;
        border-radius: 6px;
      "
    >
      ${otp}
    </div>

    <p style="color: #666; font-size: 13px;">
      This link and code will expire in 1 hour.
    </p>
  </body>
</html>`;

    await sendMail({
      to: email,
      subject: "Verify Your Email",
      html,
    });

    console.log("✅ Email sent successfully");
    console.log(verificationLink);
  } catch (err) {
    console.log(err);
    // Rethrown so callers can tell the user the mail did NOT go out. This
    // used to be swallowed: signup answered "please verify your email" while
    // no email existed, and the account was permanently locked out of login
    // ("User not verified") with no hint why.
    throw new Error("VERIFICATION_EMAIL_SEND_FAILED");
  }
};

export default SendVerficationEmail;
