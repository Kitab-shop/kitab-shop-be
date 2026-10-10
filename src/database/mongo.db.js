
import mongoose from "mongoose";
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, "../../.env") });

const mongoUrl =
  process.env.mango_url ||
  process.env.mongo_url ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL;

const connectMongoDB = async () => {
  try {
    if (!mongoUrl) {
      throw new Error(
        "Mongo connection string missing. Set mango_url, MONGO_URI, MONGODB_URI, or MONGO_URL in .env."
      );
    }

    await mongoose.connect(mongoUrl, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      // Was unset, which means the driver default of 0 — NO socket timeout at all, so a
      // single hung operation held its connection out of a pool of 10 forever. On a
      // 1-vCPU box with a local mongod, 45s is already far beyond any healthy query.
      socketTimeoutMS: 45000,
      // The pool started empty, so the first request after an idle period paid a full
      // TCP + auth handshake before doing any work. Two warm sockets is cheap insurance.
      minPoolSize: 2,
      // Retire idle sockets rather than holding all 10 open indefinitely.
      maxIdleTimeMS: 60000,
      // Mongoose otherwise issues createIndex for every declared index on every boot.
      // Harmless in development; on a small production box it is a burst of index work
      // at each PM2 restart, and Order.model.js documents a real IndexKeySpecsConflict
      // hazard from it. Indexes in production are applied deliberately, not on boot.
      autoIndex: process.env.NODE_ENV !== "production",
    });

    console.log("✅ MongoDB Connected");
  } catch (ex) {
    console.error("❌ MongoDB Connection Error:", ex.message);
    process.exit(1);
  }
};

// There was no listener of any kind, so a mongod restart — entirely plausible on a 4GB
// VPS running its own database — was completely silent: the driver reconnected (or did
// not) and the only trace was requests failing for reasons nothing explained.
mongoose.connection.on("error", (error) => {
  console.error("❌ MongoDB error:", error?.message || error);
});
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️  MongoDB disconnected");
});
mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB reconnected");
});

export default connectMongoDB;
