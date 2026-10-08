import jwt from "jsonwebtoken";
import { Profile } from "../models/Profile.js";

export async function requireAuth(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    req.userId = jwt.verify(token, process.env.JWT_SECRET).sub;
    const profile = await Profile.findById(req.userId).select("account_status");
    if (!profile) return res.status(401).json({ error: "Account not found." });
    if (profile.account_status === "suspended") return res.status(403).json({ error: "This account is suspended. Contact Ziba support for help." });
    next();
  }
  catch { return res.status(401).json({ error: "Your session has expired. Sign in again." }); }
}

export async function requireAdmin(req, res, next) {
  try {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(token || "", process.env.JWT_SECRET);
    const profile = await Profile.findById(payload.sub);
    if (!profile || !profile.roles.includes("admin")) return res.status(403).json({ error: "Admin access required." });
    req.admin = profile; req.userId = profile.id; next();
  } catch { return res.status(401).json({ error: "Admin access required." }); }
}
