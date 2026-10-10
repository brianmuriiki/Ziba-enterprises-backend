import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createPublicKey } from "node:crypto";
import { Profile } from "../models/Profile.js";

const publicProfile = (profile) => ({ id: profile.id, full_name: profile.full_name, email: profile.email, phone: profile.phone, avatar_url: profile.avatar_url, roles: profile.roles, account_status: profile.account_status, rating_avg: profile.rating_avg, review_count: profile.review_count, seller_verified: profile.seller_verified, landlord_verified: profile.landlord_verified, service_provider_verified: profile.service_provider_verified, created_at: profile.created_at });
const issueToken = (profile) => jwt.sign({ sub: profile.id }, process.env.JWT_SECRET, { expiresIn: "1d" });

export async function register(req, res, next) {
  try {
    const { full_name, email, password } = req.body || {};
    if (typeof full_name !== "string" || !full_name.trim() || typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "Enter your name, a valid email, and a password with at least 8 characters." });
    const profile = await Profile.create({ full_name: full_name.trim(), email, password_hash: await bcrypt.hash(password, 12) });
    res.status(201).json({ token: issueToken(profile), user: publicProfile(profile) });
  } catch (error) { if (error?.code === 11000) return res.status(409).json({ error: "An account with that email already exists." }); next(error); }
}
export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const profile = await Profile.findOne({ email }).select("+password_hash");
    if (!profile?.password_hash || !await bcrypt.compare(password || "", profile.password_hash)) return res.status(401).json({ error: "Email or password is incorrect." });
    if (profile.account_status === "suspended") return res.status(403).json({ error: "This account is suspended. Contact Ziba support for help." });
    res.json({ token: issueToken(profile), user: publicProfile(profile) });
  } catch (error) { next(error); }
}
let googleCertificates = null;
let googleCertificatesExpiresAt = 0;

async function getGoogleCertificate(kid, refresh = false) {
  if (refresh || !googleCertificates || Date.now() >= googleCertificatesExpiresAt) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!response.ok) throw new Error("Unable to retrieve Google signing certificates.");
    const { keys = [] } = await response.json();
    googleCertificates = Object.fromEntries(keys.filter((key) => key.kty === "RSA" && key.kid).map((key) => [key.kid, createPublicKey({ key, format: "jwk" })]));
    const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] || 300);
    googleCertificatesExpiresAt = Date.now() + maxAge * 1000;
  }
  return googleCertificates[kid] || null;
}

async function verifyGoogleCredential(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("Google sign-in is not configured on the server.");
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) return null;
  let header;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { return null; }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  let certificate = await getGoogleCertificate(header.kid);
  if (!certificate) certificate = await getGoogleCertificate(header.kid, true);
  if (!certificate) return null;
  let claims;
  try {
    claims = jwt.verify(idToken, certificate, {
      algorithms: ["RS256"],
      audience: clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
  } catch { return null; }
  if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || !(claims.email_verified === true || claims.email_verified === "true")) return null;
  return claims;
}

export async function googleSignIn(req, res, next) {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: "Google sign-in is not configured on the server." });
    const claims = await verifyGoogleCredential(req.body?.credential);
    if (!claims) return res.status(401).json({ error: "Google sign-in could not be verified. Please try again." });
    const email = claims.email.trim().toLowerCase();
    let profile = await Profile.findOne({ google_sub: claims.sub }).select("+google_sub");
    if (!profile) {
      profile = await Profile.findOne({ email }).select("+google_sub");
      if (profile?.google_sub && profile.google_sub !== claims.sub) return res.status(409).json({ error: "This email is already linked to a different Google account." });
      if (profile) {
        profile.google_sub = claims.sub;
        if (!profile.avatar_url && claims.picture) profile.avatar_url = claims.picture;
        await profile.save();
      } else {
        profile = await Profile.create({
          full_name: (typeof claims.name === "string" && claims.name.trim()) || email.split("@")[0],
          email,
          google_sub: claims.sub,
          avatar_url: typeof claims.picture === "string" ? claims.picture : null,
        });
      }
    }
    if (profile.account_status === "suspended") return res.status(403).json({ error: "This account is suspended. Contact Ziba support for help." });
    res.json({ token: issueToken(profile), user: publicProfile(profile) });
  } catch (error) { if (error?.code === 11000) return res.status(409).json({ error: "An account with that email already exists." }); next(error); }
}

export async function me(req, res, next) {
  try { const profile = await Profile.findById(req.userId); if (!profile) return res.status(404).json({ error: "Account not found." }); res.json({ user: publicProfile(profile) }); }
  catch (error) { next(error); }
}
