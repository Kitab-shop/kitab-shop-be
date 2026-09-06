import { sendMail } from "../../utils/mailer.js";
import dotenv from "dotenv";

dotenv.config();

export const SendCodOtpEmail = async (email, otp) => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Confirm your Cash on Delivery order</title>
  </head>
  <body
    style="
      font-family: Arial, sans-serif;
      background: #f5f5f5;
      padding: 40px;
      text-align: center;
    "
  >
    <h2>Confirm your Cash on Delivery order</h2>

    <p>Enter this code at checkout to confirm you placed this Cash on Delivery order.</p>

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
      This code will expire in 10 minutes. If you did not request this, you can ignore this email.
    </p>
  </body>
</html>`;

  await sendMail({
    to: email,
    subject: "Your Cash on Delivery verification code",
    html,
  });
};

export default SendCodOtpEmail;
