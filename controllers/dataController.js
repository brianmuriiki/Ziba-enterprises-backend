import jwt from "jsonwebtoken";
import { ObjectId, mongoose } from "mongoose";

const tables = new Set(["profiles", "profiles_public", "user_roles", "verification_docs", "products", "product_images", "properties", "property_images", "services", "conversations", "messages", "orders", "reviews", "saved_listings", "reports", "notifications"]);
const ownerFields = { user_roles: "profile_id", verification_docs: "profile_id", products: "seller_id", properties: "landlord_id", services: "provider_id", conversations: "buyer_id", messages: "sender_id", orders: "buyer_id", reviews: "reviewer_id", saved_listings: "profile_id", reports: "reported_by", notifications: "profile_id" };
const privateTables = new Set(["user_roles", "verification_docs", "conversations", "messages", "orders", "reviews", "saved_listings", "notifications"]);
function mongoId(value) { return typeof value === "string" && ObjectId.isValid(value) ? new ObjectId(value) : value; }
function parseFilters(filters = []) {
  const query = {};
  for (const filter of filters) {
    if (filter.op === "limit") continue;
    if (filter.op === "or") {
      const alternatives = [...String(filter.value).matchAll(/(?:^|,|and\()([\w.]+)\.(eq|neq|is)\.([^,)]+)/g)].map(([, field, op, value]) => ({ [field]: op === "is" && value === "null" ? null : op === "neq" ? { $ne: value } : value }));
      if (alternatives.length) query.$or = alternatives;
      continue;
    }
    const { field, op, value } = filter;
    if (field === "$search" && op === "text") { query.$text = { $search: String(value).slice(0, 100) }; continue; }
    if (op === "eq") query[field === "id" ? "_id" : field] = field === "id" ? mongoId(value) : value;
    else if (op === "neq") query[field] = { $ne: value };
    else if (op === "is") query[field] = value === null ? null : value;
    else if (op === "gte") query[field] = { ...(query[field] || {}), $gte: Number(value) };
    else if (op === "lte") query[field] = { ...(query[field] || {}), $lte: Number(value) };
    else if (op === "ilike") query[field] = new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*"), "i");
  }
  return query;
}
function asClient(doc) { if (!doc) return doc; const { _id, ...data } = doc; return { ...data, id: String(_id) }; }
async function enrich(table, docs) {
  const rows = docs.map(asClient);
  for (const row of rows) {
    if (table === "products" || table === "properties" || table === "services") {
      const ownerId = row.seller_id || row.landlord_id || row.provider_id;
      if (ownerId) { const profile = await mongoose.connection.collection("profiles").findOne({ _id: mongoId(ownerId) }); row.profiles = profile ? { full_name: profile.full_name, avatar_url: profile.avatar_url, seller_verified: profile.seller_verified, landlord_verified: profile.landlord_verified, service_provider_verified: profile.service_provider_verified, rating_avg: profile.rating_avg, review_count: profile.review_count } : null; }
    }
    const imageTable = table === "products" ? "product_images" : table === "properties" ? "property_images" : null;
    if (imageTable) row[imageTable] = (await mongoose.connection.collection(imageTable).find({ [`${table === "products" ? "product" : "property"}_id`]: row.id }).sort({ sort_order: 1 }).toArray()).map(asClient);
    if (["messages", "profiles_public"].includes(table) && row.sender_id) { const p = await mongoose.connection.collection("profiles").findOne({ _id: mongoId(row.sender_id) }); row.profiles = p ? { full_name: p.full_name, avatar_url: p.avatar_url } : null; }
    if (table === "profiles_public") { delete row.email; delete row.phone; delete row.password_hash; }
  }
  return rows;
}
export async function handleData(req, res, next) {
  try {
    const table = req.params.table === "profiles_public" ? "profiles" : req.params.table;
    if (!tables.has(req.params.table)) return res.status(404).json({ error: "Unknown data collection." });
    const { action = "select", values, filters = [], sort = {}, single, maybe, head, count } = req.body || {};
    const collection = mongoose.connection.collection(table);
    let query = parseFilters(filters);
    const userId = (() => { try { return jwt.verify(req.get("authorization")?.replace(/^Bearer\s+/i, ""), process.env.JWT_SECRET).sub; } catch { return null; } })();
    const admin = userId && await mongoose.connection.collection("profiles").findOne({ _id: mongoId(userId), roles: "admin" });
    if (action !== "select" && !userId) return res.status(401).json({ error: "Sign in to continue." });
    if (action !== "select" && req.params.table === "profiles_public") return res.status(403).json({ error: "Public profiles cannot be changed through this route." });
    if (action !== "select" && table === "profiles" && !admin && action !== "update") return res.status(403).json({ error: "Profile records cannot be created or deleted here." });
    if (action !== "select" && !admin && table === "profiles") query._id = mongoId(userId);
    if (action !== "select" && !admin && ownerFields[table] && !["messages", "orders"].includes(table)) query[ownerFields[table]] = userId;
    if (action === "select" && !userId && (privateTables.has(table) || req.params.table === "profiles")) return res.status(401).json({ error: "Sign in to continue." });
    if (action === "select" && userId && !admin && table === "profiles") query._id = mongoId(userId);
    if (action === "select" && userId && !admin && table === "conversations") query = { $and: [query, { $or: [{ buyer_id: userId }, { other_party_id: userId }] }] };
    if (action === "select" && userId && !admin && table === "orders") query = { $and: [query, { $or: [{ buyer_id: userId }, { seller_id: userId }] }] };
    if (action === "update" && userId && !admin && table === "orders") query = { $and: [query, { $or: [{ buyer_id: userId }, { seller_id: userId }] }] };
    if (action === "select" && userId && !admin && table === "messages") {
      const conversations = await mongoose.connection.collection("conversations").find({ $or: [{ buyer_id: userId }, { other_party_id: userId }] }).project({ _id: 0, id: 1 }).toArray();
      query.conversation_id = { $in: conversations.map((row) => row.id) };
    }
    if (action === "update" && userId && !admin && table === "messages") {
      const conversations = await mongoose.connection.collection("conversations").find({ $or: [{ buyer_id: userId }, { other_party_id: userId }] }).project({ _id: 0, id: 1 }).toArray();
      query.conversation_id = { $in: conversations.map((row) => row.id) };
    }
    if (action === "select" && !userId && ["products", "properties", "services"].includes(table)) query.status = "active";
    if (action === "select" && req.params.table === "profiles_public" && !userId) { /* Public profile summaries only. */ }
    let docs = [];
    if (action === "select") {
      const cursor = collection.find(query);
      const limitFilter = filters.find((f) => f.op === "limit");
      if (Object.keys(sort).length) cursor.sort(sort); else cursor.sort({ created_at: -1 });
      if (limitFilter) cursor.limit(Math.min(Number(limitFilter.value), 500));
      const total = count ? await collection.countDocuments(query) : null;
      if (!head) docs = await cursor.toArray();
      let data = await enrich(req.params.table, docs);
      if (single) { if (!data.length) return res.json({ data: null, count: total }); if (data.length > 1) return res.status(406).json({ error: "Expected one row, found multiple." }); data = data[0]; }
      else if (maybe) { if (data.length > 1) return res.status(406).json({ error: "Expected at most one row." }); data = data[0] || null; }
      return res.json({ data, count: total });
    }
    if (action === "insert") {
      const valuesArray = Array.isArray(values) ? values : [values];
      if (!admin && ["products", "properties", "services"].includes(table)) {
        const role = { products: "seller", properties: "landlord", services: "service_provider" }[table];
        const approved = await mongoose.connection.collection("user_roles").findOne({ profile_id: userId, role, status: "approved" });
        if (!approved) return res.status(403).json({ error: `An approved ${role.replace("_", " ")} account is required to publish.` });
      }
      if (!admin && ["product_images", "property_images"].includes(table)) {
        const parentTable = table === "product_images" ? "products" : "properties";
        const parentField = table === "product_images" ? "product_id" : "property_id";
        const parentOwner = table === "product_images" ? "seller_id" : "landlord_id";
        for (const value of (Array.isArray(values) ? values : [values])) {
          if (!await mongoose.connection.collection(parentTable).findOne({ _id: mongoId(value?.[parentField]), [parentOwner]: userId })) return res.status(403).json({ error: "You can only add images to your own listings." });
        }
      }
      if (!admin && table === "messages") {
        for (const value of valuesArray) if (!await mongoose.connection.collection("conversations").findOne({ id: value?.conversation_id, $or: [{ buyer_id: userId }, { other_party_id: userId }] })) return res.status(403).json({ error: "You are not a participant in this conversation." });
      }
      const docsToInsert = valuesArray.map((value) => ({ ...value, ...(table === "services" && !value.status ? { status: "active" } : {}), ...(ownerFields[table] && !admin ? { [ownerFields[table]]: userId } : {}), ...(table === "user_roles" && !admin ? { role: ["seller", "landlord", "service_provider"].includes(value?.role) ? value.role : "buyer", status: "pending" } : {}), created_at: new Date().toISOString() }));
      const inserted = await collection.insertMany(docsToInsert);
      const result = docsToInsert.map((doc, i) => asClient({ ...doc, _id: inserted.insertedIds[i] }));
      return res.json({ data: single ? result[0] : result });
    }
    if (action === "update") {
      let updateValues = values || {};
      if (!admin && table === "profiles") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => ["full_name", "phone", "avatar_url"].includes(key)));
      if (!admin && table === "user_roles") updateValues = { status: "pending", application_data: updateValues.application_data };
      if (!admin && table === "verification_docs") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => ["doc_type", "storage_path"].includes(key)));
      if (!admin && table === "messages") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => key === "read_at"));
      if (!admin && table === "reports") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => ["reason"].includes(key)));
      const result = await collection.updateMany(query, { $set: updateValues }); return res.json({ data: null, count: result.modifiedCount });
    }
    if (action === "delete") { const result = await collection.deleteMany(query); return res.json({ data: null, count: result.deletedCount }); }
    return res.status(400).json({ error: "Invalid operation." });
  } catch (error) { next(error); }
}
