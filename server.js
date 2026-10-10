import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import authRoutes from "./routes/authRoutes.js";
import { connectDatabase } from "./database/connect.js";
import { Profile } from "./models/Profile.js";
import { requireAdmin as adminOnly, requireAuth as auth } from "./middleware/auth.js";
import dataRoutes from "./routes/dataRoutes.js";
import assistantRoutes from "./routes/assistantRoutes.js";

dotenv.config({ path: new URL("./.env", import.meta.url) });

const app = express();
const port = Number(process.env.PORT || process.env.API_PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;
const mongoId = (value) => typeof value === "string" && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : value;
const asClient = (doc) => {
  if (!doc) return doc;
  const { _id, ...data } = doc;
  return { ...data, id: String(_id) };
};

app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(",") || true }));
app.use(express.json({ limit: "14mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));

app.use("/api/auth", authRoutes);

app.use("/api/data", dataRoutes);
app.use("/api/assistant", assistantRoutes);

app.post("/api/uploads", auth, async (req, res, next) => {
  try {
    const file = req.body?.file;
    if (!file || !file.startsWith("data:")) return res.status(400).json({ error: "Upload data is missing." });
    const bucket = req.body.bucket;
    const allowedBuckets = new Set(["public-listing-images", "private-verification-docs", "private-chat-attachments"]);
    if (!allowedBuckets.has(bucket)) return res.status(400).json({ error: "Invalid upload destination." });
    const path = String(req.body.path || "");
    if (!path || path.length > 500 || path.includes("..") || path.startsWith("/")) return res.status(400).json({ error: "Invalid upload path." });
    const match = /^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(file);
    if (!match) return res.status(415).json({ error: "Upload a JPG, PNG, WebP, GIF, or PDF file." });
    const [, mimeType, content] = match;
    const fileBytes = Buffer.from(content, "base64");
    const size = fileBytes.length;
    const contentHash = createHash("sha256").update(fileBytes).digest("hex");
    const validSignature = mimeType === "image/jpeg" ? fileBytes[0] === 0xff && fileBytes[1] === 0xd8 && fileBytes[2] === 0xff
      : mimeType === "image/png" ? fileBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mimeType === "image/gif" ? ["GIF87a", "GIF89a"].includes(fileBytes.subarray(0, 6).toString())
      : mimeType === "image/webp" ? fileBytes.subarray(0, 4).toString() === "RIFF" && fileBytes.subarray(8, 12).toString() === "WEBP"
      : mimeType === "application/pdf" ? fileBytes.subarray(0, 5).toString() === "%PDF-"
      : false;
    if (!validSignature) return res.status(415).json({ error: "The file contents do not match the selected image or PDF format." });
    const maxSize = bucket === "private-chat-attachments" ? 10 * 1024 * 1024 : 8 * 1024 * 1024;
    if (size > maxSize || (bucket === "private-chat-attachments" && !mimeType.startsWith("image/"))) return res.status(413).json({ error: `File must be ${maxSize / (1024 * 1024)} MB or smaller.` });
    if (bucket === "private-verification-docs" && !path.startsWith(`verification/${req.userId}/`)) return res.status(403).json({ error: "Verification files must be saved to your private folder." });
    if (bucket === "public-listing-images") {
      const [ownerId, listingId] = path.split("/");
      if (ownerId !== String(req.userId)) return res.status(403).json({ error: "You can only upload photos for your own listings." });
      const parent = await Promise.all(["products", "properties"].map((table) => mongoose.connection.collection(table).findOne({ _id: mongoId(listingId), ...(table === "products" ? { seller_id: req.userId } : { landlord_id: req.userId }) })));
      if (!parent.some(Boolean)) return res.status(403).json({ error: "Create your listing before uploading its photos." });
    }
    if (bucket === "private-chat-attachments") {
      const [conversationId, ownerId] = path.split("/");
      const conversation = ownerId === String(req.userId) && await mongoose.connection.collection("conversations").findOne({ $and: [{ $or: [{ id: conversationId }, { _id: mongoId(conversationId) }] }, { $or: [{ buyer_id: req.userId }, { other_party_id: req.userId }] }] });
      if (!conversation) return res.status(403).json({ error: "You can only upload attachments to your own conversations." });
    }
    const uploads = mongoose.connection.collection("uploads");
    const previous = await uploads.findOne({ path });
    if (previous && previous.owner_id !== String(req.userId)) return res.status(409).json({ error: "Upload path is already in use." });
    const duplicateImage = bucket === "public-listing-images" && await uploads.findOne({ content_hash: contentHash, bucket, owner_id: { $ne: String(req.userId) } });
    await uploads.updateOne({ path, owner_id: String(req.userId) }, { $set: { path, owner_id: String(req.userId), bucket, content_hash: contentHash, data: file, created_at: new Date().toISOString() } }, { upsert: true });
    if (duplicateImage && bucket === "public-listing-images") {
      const listingRefs = [path, duplicateImage.path].map((uploadPath) => {
        const [ownerId, listingId] = uploadPath.split("/");
        return { ownerId, listingId };
      });
      for (const { ownerId, listingId } of listingRefs) for (const table of ["products", "properties"]) {
        const ownerField = table === "products" ? "seller_id" : "landlord_id";
        const listing = await mongoose.connection.collection(table).findOne({ _id: mongoId(listingId), [ownerField]: ownerId });
        if (!listing) continue;
        const riskFlags = [...new Set([...(listing.risk_flags || []), "duplicate_image"])];
        await mongoose.connection.collection(table).updateOne({ _id: listing._id }, { $set: { risk_flags: riskFlags, moderation_status: "review" } });
      }
    }
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
    const dataUrl = /^data:([^,]*),(.*)$/s.exec(file.data || "");
    if (!dataUrl) return res.status(415).json({ error: "The stored file has an unsupported format." });
    const [, metadata, content] = dataUrl;
    const mimeType = metadata.split(";")[0] || "application/octet-stream";
    const isBase64 = metadata.split(";").includes("base64");
    const body = isBase64 ? Buffer.from(content, "base64") : Buffer.from(decodeURIComponent(content), "utf8");
    const inlineTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);
    res.set({
      "Content-Type": inlineTypes.has(mimeType) ? mimeType : "application/octet-stream",
      "Content-Disposition": inlineTypes.has(mimeType) ? "inline" : "attachment",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(body);
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
    if (file.bucket === "private-verification-docs" && !admin) return res.status(403).json({ error: "Only platform reviewers can access verification documents." });
    let participant = false;
    const conversationId = path.split("/")[0];
    if (file.bucket === "private-chat-attachments") participant = Boolean(await mongoose.connection.collection("conversations").findOne({
      $and: [
        { $or: [{ id: conversationId }, { _id: mongoId(conversationId) }] },
        { $or: [{ buyer_id: req.userId }, { other_party_id: req.userId }] },
      ],
    }));
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
  try { const users = await Profile.find().sort({ created_at: -1 }).limit(500).lean(); res.json(users.map((u) => ({ ...asClient(u), user_roles: (Array.isArray(u.roles) ? u.roles : []).map((role) => ({ role, status: "approved" })) }))); } catch (error) { next(error); }
});
app.get("/api/admin/overview", adminOnly, async (_req, res, next) => {
  try {
    const [users, products, properties, services, orders, reports, pending] = await Promise.all(["profiles", "products", "properties", "services", "orders", "reports", "user_roles"].map((table) => mongoose.connection.collection(table).countDocuments()));
    const [productRows, propertyRows, serviceRows, reportRows] = await Promise.all(["products", "properties", "services", "reports"].map((table) => mongoose.connection.collection(table).find().sort({ created_at: -1 }).limit(100).toArray()));
    const listings = [...productRows.map((x) => ({ ...asClient(x), type: "product" })), ...propertyRows.map((x) => ({ ...asClient(x), type: "property" })), ...serviceRows.map((x) => ({ ...asClient(x), type: "service" }))];
    const enrichedReports = await Promise.all(reportRows.map(async (report) => {
      const row = asClient(report);
      const reportTable = { product: "products", property: "properties", service: "services", message: "messages", profile: "profiles" }[row.target_type];
      if (!reportTable) return row;
      const target = await mongoose.connection.collection(reportTable).findOne({ _id: mongoId(row.target_id) });
      if (!target) return row;
      if (["products", "properties", "services"].includes(reportTable)) {
        const ownerId = target.seller_id || target.landlord_id || target.provider_id;
        const owner = ownerId && await mongoose.connection.collection("profiles").findOne({ _id: mongoId(ownerId) });
        row.target = { kind: "listing", ...asClient(target), owner: owner ? { full_name: owner.full_name, phone: owner.phone } : null };
      } else if (reportTable === "messages") {
        const sender = await mongoose.connection.collection("profiles").findOne({ _id: mongoId(target.sender_id) });
        row.target = { kind: "message", ...asClient(target), profiles: sender ? { full_name: sender.full_name } : null };
      } else {
        const profileTarget = asClient(target);
        delete profileTarget.password_hash;
        row.target = { kind: "profile", ...profileTarget };
      }
      return row;
    }));
    res.json({ counts: { users, listings: products + properties + services, orders, reports, pending }, listings, reports: enrichedReports });
  } catch (error) { next(error); }
});
app.post("/api/admin/verify-role", adminOnly, async (req, res, next) => {
  try {
    const { role_id, status } = req.body;
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid review status." });
    const roles = mongoose.connection.collection("user_roles");
    const result = await roles.findOneAndUpdate({ _id: mongoId(role_id) }, { $set: { status, verified_at: status === "approved" ? new Date().toISOString() : null } }, { returnDocument: "after" });
    const application = result?.value || result;
    if (!application) return res.status(404).json({ error: "Application not found." });
    const verifiedField = { seller: "seller_verified", landlord: "landlord_verified", service_provider: "service_provider_verified" }[application.role];
    if (verifiedField) {
      const stillApproved = await roles.findOne({ profile_id: application.profile_id, role: application.role, status: "approved" });
      await mongoose.connection.collection("profiles").updateOne({ _id: mongoId(application.profile_id) }, { $set: { [verifiedField]: Boolean(stillApproved) } });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/admin/listing-status", adminOnly, async (req, res, next) => {
  try {
    const { type, id, status } = req.body;
    const table = { product: "products", property: "properties", service: "services" }[type];
    if (!table || !["active", "suspended", "rejected", "draft"].includes(status)) return res.status(400).json({ error: "Invalid listing status." });
    await mongoose.connection.collection(table).updateOne({ _id: mongoId(id) }, { $set: { status, ...(status === "active" ? { moderation_status: "clear", risk_flags: [] } : {}) } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/admin/user-status", adminOnly, async (req, res, next) => {
  try {
    const { profile_id, status } = req.body;
    if (!["active", "suspended"].includes(status)) return res.status(400).json({ error: "Invalid account status." });
    await Profile.updateOne({ _id: mongoId(profile_id) }, { $set: { account_status: status } });
    for (const table of ["products", "properties", "services"]) {
      const ownerField = { products: "seller_id", properties: "landlord_id", services: "provider_id" }[table];
      if (status === "suspended") await mongoose.connection.collection(table).updateMany({ [ownerField]: String(profile_id), status: "active" }, { $set: { status: "suspended", held_for_account: true } });
      else await mongoose.connection.collection(table).updateMany({ [ownerField]: String(profile_id), held_for_account: true, moderation_status: { $ne: "review" } }, { $set: { status: "active" }, $unset: { held_for_account: "" } });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/admin/report-status", adminOnly, async (req, res, next) => {
  try {
    const { report_id, status, resolution_note, action } = req.body;
    if (!["investigating", "resolved", "dismissed"].includes(status) || ![undefined, "hide", "take_down", "suspend_account"].includes(action)) return res.status(400).json({ error: "Invalid report action." });
    const reports = mongoose.connection.collection("reports");
    const report = await reports.findOne({ _id: mongoId(report_id) });
    if (!report) return res.status(404).json({ error: "Report not found." });
    if (action === "hide" || action === "take_down") {
      const table = { product: "products", property: "properties", service: "services" }[report.target_type];
      if (!table) return res.status(400).json({ error: "Only listing reports can hide a listing." });
      await mongoose.connection.collection(table).updateOne({ _id: mongoId(report.target_id) }, { $set: { status: "suspended", moderation_status: "review", held_by_report: true } });
    }
    if (action === "suspend_account") {
      let profileId = report.target_type === "profile" ? report.target_id : null;
      if (report.target_type === "message") {
        const message = await mongoose.connection.collection("messages").findOne({ _id: mongoId(report.target_id) });
        profileId = message?.sender_id || null;
      }
      if (!profileId) return res.status(400).json({ error: "This report is not linked to a user account." });
      await Profile.updateOne({ _id: mongoId(profileId) }, { $set: { account_status: "suspended" } });
      for (const [table, ownerField] of [["products", "seller_id"], ["properties", "landlord_id"], ["services", "provider_id"]]) await mongoose.connection.collection(table).updateMany({ [ownerField]: String(profileId), status: "active" }, { $set: { status: "suspended", held_for_account: true } });
    }
    await reports.updateOne({ _id: mongoId(report_id) }, { $set: { status, resolution_note: String(resolution_note || "").slice(0, 1000) || null, reviewed_by: req.admin.id, reviewed_at: new Date().toISOString() } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/admin/notifications", adminOnly, async (req, res, next) => {
  try { const audience = req.body.audience; const profiles = await Profile.find(audience === "all" ? {} : { roles: ({ buyers: "buyer", sellers: "seller", landlords: "landlord", service_providers: "service_provider" })[audience] || "buyer" }).select("_id").limit(5000).lean(); if (!req.body.title?.trim() || !req.body.body?.trim()) return res.status(400).json({ error: "Title and message are required." }); await mongoose.connection.collection("notifications").insertMany(profiles.map((p) => ({ profile_id: String(p._id), title: req.body.title, body: req.body.body, created_at: new Date().toISOString(), read_at: null }))); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post("/api/admin/seed", adminOnly, (_req, res) => res.json({ ok: true, message: "MongoDB is ready; listings are created by users through the API." }));

async function sendUpcomingReminders() {
  const now = Date.now();
  const orders = await mongoose.connection.collection("orders").find({
    status: "accepted",
    scheduled_at: { $gte: new Date(now).toISOString(), $lte: new Date(now + 24 * 60 * 60 * 1000).toISOString() },
    reminder_sent_at: { $exists: false },
  }).limit(200).toArray();
  for (const order of orders) {
    const sentAt = new Date().toISOString();
    const claimed = await mongoose.connection.collection("orders").updateOne({ _id: order._id, reminder_sent_at: { $exists: false } }, { $set: { reminder_sent_at: sentAt } });
    if (!claimed.modifiedCount) continue;
    const date = new Date(order.scheduled_at).toLocaleString();
    await mongoose.connection.collection("notifications").insertMany([order.buyer_id, order.seller_id].map((profileId) => ({
      profile_id: String(profileId),
      title: order.listing_type === "property" ? "Viewing reminder" : order.listing_type === "service" ? "Booking reminder" : "Request reminder",
      body: `Your scheduled ${order.listing_type} appointment is ${date}.`,
      order_id: String(order._id),
      created_at: sentAt,
      read_at: null,
    })));
  }
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error?.name === "ValidationError" || error?.name === "CastError") return res.status(400).json({ error: "Invalid request data." });
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (!jwtSecret) throw new Error("JWT_SECRET is required in the backend environment.");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required in the backend environment.");
await connectDatabase();
await Promise.all(["products", "properties", "services"].map((name) => mongoose.connection.collection(name).createIndex({ title: "text", description: "text", category: "text" })));
await mongoose.connection.collection("rate_limits").createIndex({ key: 1, bucket: 1 }, { unique: true });
await mongoose.connection.collection("rate_limits").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
await mongoose.connection.collection("saved_searches").createIndex({ profile_id: 1, listing_type: 1 });
setInterval(() => { void sendUpcomingReminders().catch((error) => console.error("Reminder delivery failed:", error)); }, 10 * 60 * 1000);
void sendUpcomingReminders().catch((error) => console.error("Reminder delivery failed:", error));
app.listen(port, () => console.log(`Ziba API listening on http://localhost:${port}`));
