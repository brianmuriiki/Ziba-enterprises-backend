import { Listing } from "../models/Listing.js";
import { mongoose } from "../database/connect.js";

export async function listListings(req, res, next) {
  try {
    const filter = { status: "active" };
    if (["product", "property", "service"].includes(req.query.type)) filter.type = req.query.type;
    if (req.query.q) filter.$text = { $search: String(req.query.q).slice(0, 100) };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.location) filter.location = new RegExp(String(req.query.location).slice(0, 80), "i");
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
    const results = await Listing.find(filter).sort({ created_at: -1 }).limit(limit).populate("owner_id", "full_name avatar_url").lean();
    res.json(results.map((item) => ({ ...item, id: String(item._id), owner_id: String(item.owner_id?._id || item.owner_id), profiles: item.owner_id ? { full_name: item.owner_id.full_name, avatar_url: item.owner_id.avatar_url } : null })));
  } catch (error) { next(error); }
}
export async function createListing(req, res, next) {
  try {
    const { type, title, description, price, price_range, category, location, details, images, status } = req.body || {};
    if (!["product", "property", "service"].includes(type) || !title?.trim() || !description?.trim()) return res.status(400).json({ error: "Type, title, and description are required." });
    const role = { product: "seller", property: "landlord", service: "service_provider" }[type];
    const approved = await mongoose.connection.collection("user_roles").findOne({ profile_id: req.userId, role, status: "approved" });
    if (!approved) return res.status(403).json({ error: `An approved ${role.replace("_", " ")} account is required to publish.` });
    const listing = await Listing.create({ type, title: title.trim(), description: description.trim(), price, price_range, category, location, details, images, status: status === "draft" ? "draft" : "active", owner_id: req.userId });
    res.status(201).json({ listing });
  } catch (error) { next(error); }
}
export async function updateListing(req, res, next) {
  try {
    const fields = ["title", "description", "price", "price_range", "category", "location", "details", "images", "status"];
    const update = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => fields.includes(key)));
    const listing = await Listing.findOneAndUpdate({ _id: req.params.id, owner_id: req.userId }, update, { new: true, runValidators: true });
    if (!listing) return res.status(404).json({ error: "Listing not found." }); res.json({ listing });
  } catch (error) { next(error); }
}
export async function deleteListing(req, res, next) {
  try { const listing = await Listing.findOneAndDelete({ _id: req.params.id, owner_id: req.userId }); if (!listing) return res.status(404).json({ error: "Listing not found." }); res.status(204).end(); }
  catch (error) { next(error); }
}
