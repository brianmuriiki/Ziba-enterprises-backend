import mongoose from "mongoose";
import jwt from "jsonwebtoken";

export function mongoRateLimit({ windowMs, max, keyPrefix, skip = () => false }) {
  return async (req, res, next) => {
    if (skip(req)) return next();
    try {
      const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
      let identity = req.ip || req.socket.remoteAddress || "unknown";
      try { identity = jwt.verify(token || "", process.env.JWT_SECRET).sub || identity; } catch { /* Use the client IP for signed-out requests. */ }
      const now = Date.now();
      const bucket = Math.floor(now / windowMs);
      const key = `${keyPrefix}:${identity}:${req.params.table || ""}`;
      let result;
      try {
        result = await mongoose.connection.collection("rate_limits").findOneAndUpdate(
          { key, bucket },
          { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((bucket + 2) * windowMs) } },
          { upsert: true, returnDocument: "after" },
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
        result = await mongoose.connection.collection("rate_limits").findOneAndUpdate({ key, bucket }, { $inc: { count: 1 } }, { returnDocument: "after" });
      }
      const counter = result?.value || result;
      const limit = typeof max === "function" ? max(req) : max;
      if (Number(counter?.count || 0) > limit) {
        res.set("Retry-After", String(Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000))));
        return res.status(429).json({ error: "Too many requests. Please wait a little before trying again." });
      }
      next();
    } catch (error) { next(error); }
  };
}
