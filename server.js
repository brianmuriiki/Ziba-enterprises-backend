import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongoose";
import authRoutes from "./routes/authRoutes.js";
import listingRoutes from "./routes/listingRoutes.js";
import { connectDatabase } from "./database/connect.js";
import { Profile } from "./models/Profile.js";
import { requireAdmin as adminOnly, requireAuth as auth } from "./middleware/auth.js";
import dataRoutes from "./routes/dataRoutes.js";

dotenv.config({ path: new URL("./.env", import.meta.url) });

const app = express();
const port = Number(process.env.API_PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;

app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(",") || true }));
app.use(express.json({ limit: "14mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));

app.use("/api/auth", authRoutes);

app.use("/api/listings", listingRoutes);

app.use("/api/data", dataRoutes);

app.post("/api/uploads", auth, async (req, res, next) => {
  try {
    const file = req.body?.file;
    if (!file || !file.startsWith("data:")) return res.status(400).json({ error: "Upload data is missing." });
    const path = req.body.path || `${req.userId}/${Date.now()}`;
    await mongoose.connection.collection("uploads").updateOne({ path }, { $set: { path, owner_id: req.userId, bucket: req.body.bucket || "private", data: file, created_at: new Date().toISOString() } }, { upsert: true });
    res.json({ path });
  } catch (error) { next(error); }
});
app.get("/api/uploads/:path", async (req, res, next) => {
  try {
    const path = decodeURIComponent(req.params.path);
    const file = await mongoose.connection.collection("uploads").findOne({ path });
    if (!file) return res.status(404).json({ error: "File not found." });
    if (file.bucket !== "public-listing-images") {
      try { const payload = jwt.verify(req.query.token || "", jwtSecret); if (payload.purpose !== "upload" || payload.path !== path) throw new Error("Invalid token"); }
      catch { return res.status(401).json({ error: "A valid file access link is required." }); }
    }
    res.redirect(file.data);
  }
  catch (error) { next(error); }
});

app.post("/api/uploads/signed-url", auth, async (req, res, next) => {
  try {
    const path = String(req.body.path || "");
    const file = await mongoose.connection.collection("uploads").findOne({ path });
    if (!file) return res.status(404).json({ error: "File not found." });
    const profile = await Profile.findById(req.userId);
    const admin = profile?.roles?.includes("admin");
    let participant = false;
    const conversationId = path.split("/")[0];
    if (file.bucket === "private-chat-attachments") participant = Boolean(await mongoose.connection.collection("conversations").findOne({ id: conversationId, $or: [{ buyer_id: req.userId }, { other_party_id: req.userId }] }));
    if (file.owner_id !== req.userId && !admin && !participant) return res.status(403).json({ error: "You cannot access this file." });
    const token = jwt.sign({ purpose: "upload", path }, jwtSecret, { expiresIn: "1h" });
    res.json({ signedUrl: `${req.protocol}://${req.get("host")}/api/uploads/${encodeURIComponent(path)}?token=${token}` });
  } catch (error) { next(error); }
});

app.get("/api/admin/pending-verifications", adminOnly, async (_req, res, next) => {
  try {
    const pending = await mongoose.connection.collection("user_roles").find({ status: "pending" }).sort({ created_at: 1 }).toArray();
    const rows = await Promise.all(pending.map(async (role) => {
      const profile = await mongoose.connection.collection("profiles").findOne({ _id: mongoId(role.profile_id) });
      const docs = await mongoose.connection.collection("verification_docs").find({ profile_id: role.profile_id, role: role.role }).toArray();
      return { ...asClient(role), profiles: profile ? { full_name: profile.full_name, phone: profile.phone, avatar_url: profile.avatar_url } : null, verification_docs: docs.map(asClient) };
    }));
    res.json(rows);
  } catch (error) { next(error); }
});
app.get("/api/admin/users", adminOnly, async (_req, res, next) => {
  try { const users = await Profile.find().sort({ created_at: -1 }).limit(500).lean(); res.json(users.map((u) => ({ ...asClient(u), user_roles: u.roles.map((role) => ({ role, status: "approved" })) }))); } catch (error) { next(error); }
});
app.get("/api/admin/overview", adminOnly, async (_req, res, next) => {
  try {
    const [users, products, properties, services, orders, reports, pending] = await Promise.all(["profiles", "products", "properties", "services", "orders", "reports", "user_roles"].map((table) => mongoose.connection.collection(table).countDocuments()));
    const [productRows, propertyRows, serviceRows, reportRows] = await Promise.all(["products", "properties", "services", "reports"].map((table) => mongoose.connection.collection(table).find().sort({ created_at: -1 }).limit(100).toArray()));
    const listings = [...productRows.map((x) => ({ ...asClient(x), type: "product" })), ...propertyRows.map((x) => ({ ...asClient(x), type: "property" })), ...serviceRows.map((x) => ({ ...asClient(x), type: "service" }))];
    res.json({ counts: { users, listings: products + properties + services, orders, reports, pending }, listings, reports: reportRows.map(asClient) });
  } catch (error) { next(error); }
});
app.post("/api/admin/verify-role", adminOnly, async (req, res, next) => {
  try { const { role_id, status } = req.body; if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid review status." }); const result = await mongoose.connection.collection("user_roles").findOneAndUpdate({ _id: mongoId(role_id) }, { $set: { status, verified_at: status === "approved" ? new Date().toISOString() : null } }, { returnDocument: "after" }); if (!result) return res.status(404).json({ error: "Application not found." }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post("/api/admin/listing-status", adminOnly, async (req, res, next) => {
  try { const { type, id, status } = req.body; const table = { product: "products", property: "properties", service: "services" }[type]; if (!table) return res.status(400).json({ error: "Invalid listing type." }); await mongoose.connection.collection(table).updateOne({ _id: mongoId(id) }, { $set: { status } }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post("/api/admin/user-status", adminOnly, async (req, res, next) => {
  try { await Profile.updateOne({ _id: mongoId(req.body.profile_id) }, { $set: { account_status: req.body.status } }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post("/api/admin/report-status", adminOnly, async (req, res, next) => {
  try { await mongoose.connection.collection("reports").updateOne({ _id: mongoId(req.body.report_id) }, { $set: { status: req.body.status, resolution_note: req.body.resolution_note || null, reviewed_by: req.admin.id, reviewed_at: new Date().toISOString() } }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post("/api/admin/notifications", adminOnly, async (req, res, next) => {
  try { const audience = req.body.audience; const profiles = await Profile.find(audience === "all" ? {} : { roles: ({ buyers: "buyer", sellers: "seller", landlords: "landlord", service_providers: "service_provider" })[audience] || "buyer" }).select("_id").limit(5000).lean(); if (!req.body.title?.trim() || !req.body.body?.trim()) return res.status(400).json({ error: "Title and message are required." }); await mongoose.connection.collection("notifications").insertMany(profiles.map((p) => ({ profile_id: String(p._id), title: req.body.title, body: req.body.body, created_at: new Date().toISOString(), read_at: null }))); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post("/api/admin/seed", adminOnly, (_req, res) => res.json({ ok: true, message: "MongoDB is ready; listings are created by users through the API." }));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error?.name === "ValidationError" || error?.name === "CastError") return res.status(400).json({ error: "Invalid request data." });
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (!jwtSecret) throw new Error("JWT_SECRET is required in the backend environment.");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required in the backend environment.");
await connectDatabase();
await Promise.all(["products", "properties", "services"].map((name) => mongoose.connection.collection(name).createIndex({ title: "text", description: "text", category: "text" })));
app.listen(port, () => console.log(`Ziba API listening on http://localhost:${port}`));
