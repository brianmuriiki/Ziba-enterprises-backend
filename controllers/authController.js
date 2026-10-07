import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Profile } from "../models/Profile.js";

const publicProfile = (profile) => ({ id: profile.id, full_name: profile.full_name, email: profile.email, phone: profile.phone, avatar_url: profile.avatar_url, roles: profile.roles, account_status: profile.account_status, created_at: profile.created_at });
const issueToken = (profile) => jwt.sign({ sub: profile.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

export async function register(req, res, next) {
  try {
    const { full_name, email, password } = req.body || {};
    if (typeof full_name !== "string" || !full_name.trim() || typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "Enter your name, a valid email, and a password with at least 8 characters." });
    const isInitialAdmin = process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
    const profile = await Profile.create({ full_name: full_name.trim(), email, password_hash: await bcrypt.hash(password, 12), ...(isInitialAdmin ? { roles: ["buyer", "admin"] } : {}) });
    res.status(201).json({ token: issueToken(profile), user: publicProfile(profile) });
  } catch (error) { if (error?.code === 11000) return res.status(409).json({ error: "An account with that email already exists." }); next(error); }
}
export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const profile = await Profile.findOne({ email }).select("+password_hash");
    if (!profile || !await bcrypt.compare(password || "", profile.password_hash)) return res.status(401).json({ error: "Email or password is incorrect." });
    if (profile.account_status === "suspended") return res.status(403).json({ error: "This account is suspended. Contact Ziba support for help." });
    res.json({ token: issueToken(profile), user: publicProfile(profile) });
  } catch (error) { next(error); }
}
export async function me(req, res, next) {
  try { const profile = await Profile.findById(req.userId); if (!profile) return res.status(404).json({ error: "Account not found." }); res.json({ user: publicProfile(profile) }); }
  catch (error) { next(error); }
}
