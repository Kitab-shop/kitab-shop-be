import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "../src/model/User.model.js";
import { CreateharhPassword } from "../src/passwordhash/password.js";
import { ADMIN_ROLES, normalizeRoles } from "../src/config/admin-permissions.config.js";

dotenv.config();

const allowedRoles = new Set(ADMIN_ROLES);

const getArg = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || "";
};

const email = String(getArg("email") || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(getArg("password") || process.env.ADMIN_PASSWORD || "");
const role = String(getArg("role") || process.env.ADMIN_ROLE || "superAdmin").trim();
const roleList = String(getArg("roles") || process.env.ADMIN_ROLES || role)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const mongoUrl =
  process.env.mango_url ||
  process.env.mongo_url ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL;

if (!email || !password) {
  console.error("Usage: npm run admin:upsert -- --email=admin@example.com --password=StrongPassword --roles=productManager,salesManager");
  console.error("Or set ADMIN_EMAIL, ADMIN_PASSWORD, and optional ADMIN_ROLES in .env.");
  process.exit(1);
}

const invalidRoles = roleList.filter((value) => !allowedRoles.has(value));
if (invalidRoles.length > 0) {
  console.error(`Invalid role(s) "${invalidRoles.join(", ")}". Use one or more of: ${[...allowedRoles].join(", ")}`);
  process.exit(1);
}

if (!mongoUrl) {
  console.error("Mongo connection string missing. Set mango_url, mongo_url, or MONGO_URI in .env.");
  process.exit(1);
}

try {
  await mongoose.connect(mongoUrl);
  const hashedPassword = await CreateharhPassword(password);
  const roles = normalizeRoles({ roles: roleList });
  const user = await User.findOneAndUpdate(
    { email },
    {
      email,
      password: hashedPassword,
      roles,
      isVerified: true,
      isActive: true,
      isBlocked: false,
      blockedAt: null,
      deletedAt: null,
    },
    { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true },
  ).select("email roles isVerified isActive isBlocked");

  console.log(`Admin account ready: ${user.email} (${user.roles.join(", ")})`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
