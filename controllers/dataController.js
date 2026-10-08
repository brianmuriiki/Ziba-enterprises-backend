import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const tables = new Set(["profiles", "profiles_public", "user_roles", "verification_docs", "products", "product_images", "properties", "property_images", "services", "conversations", "messages", "orders", "reviews", "saved_listings", "saved_searches", "reports", "notifications"]);
const ownerFields = { user_roles: "profile_id", verification_docs: "profile_id", products: "seller_id", properties: "landlord_id", services: "provider_id", conversations: "buyer_id", messages: "sender_id", orders: "buyer_id", reviews: "reviewer_id", saved_listings: "profile_id", saved_searches: "profile_id", reports: "reported_by", notifications: "profile_id" };
const privateTables = new Set(["user_roles", "verification_docs", "conversations", "messages", "orders", "reviews", "saved_listings", "saved_searches", "notifications"]);
const reportReasons = new Set(["suspected_scam", "fake_or_misleading_listing", "impersonation", "unsafe_payment_request", "harassment_or_abuse", "spam", "other"]);
const listingTables = { product: "products", property: "properties", service: "services" };
function mongoId(value) { return typeof value === "string" && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : value; }
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
const normalizeListingText = (value = "") => String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function validSchedule(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() && date.getTime() <= Date.now() + 180 * 24 * 60 * 60 * 1000 ? date.toISOString() : null;
}
function matchesSavedSearch(savedSearch, listing) {
  const criteria = savedSearch.criteria || {};
  if (criteria.category && normalizeListingText(criteria.category) !== normalizeListingText(listing.category || listing.house_type)) return false;
  const location = listing.location || listing.service_area || "";
  if (criteria.location && !normalizeListingText(location).includes(normalizeListingText(criteria.location))) return false;
  if (criteria.query && !normalizeListingText(`${listing.title} ${listing.description} ${listing.category || listing.house_type || ""}`).includes(normalizeListingText(criteria.query))) return false;
  const price = Number(listing.price);
  if (criteria.min_price && (!Number.isFinite(price) || price < Number(criteria.min_price))) return false;
  if (criteria.max_price && (!Number.isFinite(price) || price > Number(criteria.max_price))) return false;
  if (criteria.transaction_type && criteria.transaction_type !== (listing.transaction_type || "rent")) return false;
  return true;
}
async function notifySavedSearchMatches(listingType, listing) {
  const savedSearches = await mongoose.connection.collection("saved_searches").find({ listing_type: listingType, alerts_enabled: { $ne: false } }).limit(2000).toArray();
  const matches = savedSearches.filter((savedSearch) => matchesSavedSearch(savedSearch, listing));
  const byProfile = new Map();
  for (const savedSearch of matches) if (savedSearch.profile_id) byProfile.set(String(savedSearch.profile_id), savedSearch);
  if (!byProfile.size) return;
  const typeLabel = listingType === "property" ? "home" : listingType === "service" ? "service" : "product";
  await mongoose.connection.collection("notifications").insertMany([...byProfile.keys()].map((profileId) => ({
    profile_id: profileId,
    title: `New ${typeLabel} matches your saved search`,
    body: listing.title,
    listing_type: listingType,
    listing_id: String(listing._id),
    created_at: new Date().toISOString(),
    read_at: null,
  })));
}
async function listingRiskFlags(collection, listing, userId, table) {
  const flags = [];
  const ownerField = ownerFields[table];
  const recent = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const ownerListings = await collection.find({ created_at: { $gte: recent } }).project({ title: 1, description: 1, [ownerField]: 1 }).limit(500).toArray();
  const title = normalizeListingText(listing.title);
  const description = normalizeListingText(listing.description);
  if (ownerListings.some((item) => String(item._id) !== String(listing._id) && String(item[ownerField]) !== String(userId) && normalizeListingText(item.title) === title && normalizeListingText(item.description) === description)) flags.push("duplicate_listing_text");
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (await collection.countDocuments({ [ownerField]: userId, created_at: { $gte: dayAgo } }) > 6) flags.push("high_listing_velocity");
  if (table !== "services" && Number(listing.price) > 0) {
    const peerField = table === "products" ? "category" : "house_type";
    const peers = await collection.find({ [peerField]: listing[peerField], price: { $gt: 0 }, status: "active", ...(table === "properties" ? { transaction_type: listing.transaction_type || "rent" } : {}) }).project({ price: 1 }).limit(100).toArray();
    const prices = peers.map((item) => Number(item.price)).filter(Number.isFinite).sort((a, b) => a - b);
    if (prices.length >= 5) {
      const median = prices[Math.floor(prices.length / 2)];
      if (median > 0 && (Number(listing.price) < median * 0.1 || Number(listing.price) > median * 10)) flags.push("unusual_price");
    }
  }
  if (table !== "services" && listing._id) {
    const imageTable = table === "products" ? "product_images" : "property_images";
    const imageField = table === "products" ? "product_id" : "property_id";
    const images = await mongoose.connection.collection(imageTable).find({ [imageField]: String(listing._id) }).project({ storage_path: 1 }).toArray();
    for (const image of images) {
      const match = String(image.storage_path || "").match(/\/api\/uploads\/([^?]+)/);
      if (!match) continue;
      let path;
      try { path = decodeURIComponent(match[1]); } catch { continue; }
      const upload = await mongoose.connection.collection("uploads").findOne({ path, bucket: "public-listing-images" });
      if (upload?.content_hash && await mongoose.connection.collection("uploads").findOne({ content_hash: upload.content_hash, bucket: "public-listing-images", owner_id: { $ne: String(userId) } })) {
        flags.push("duplicate_image");
        break;
      }
    }
  }
  return flags;
}
async function enrich(table, docs) {
  const rows = docs.map(asClient);
  if (table === "profiles_public") {
    const fields = ["id", "full_name", "avatar_url", "rating_avg", "review_count", "seller_verified", "landlord_verified", "service_provider_verified"];
    return rows.map((row) => Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])));
  }
  for (const row of rows) {
    if (table === "products" || table === "properties" || table === "services") {
      const ownerId = row.seller_id || row.landlord_id || row.provider_id;
      if (ownerId) { const profile = await mongoose.connection.collection("profiles").findOne({ _id: mongoId(ownerId) }); row.profiles = profile ? { full_name: profile.full_name, avatar_url: profile.avatar_url, seller_verified: profile.seller_verified, landlord_verified: profile.landlord_verified, service_provider_verified: profile.service_provider_verified, rating_avg: profile.rating_avg, review_count: profile.review_count } : null; }
    }
    const imageTable = table === "products" ? "product_images" : table === "properties" ? "property_images" : null;
    if (imageTable) row[imageTable] = (await mongoose.connection.collection(imageTable).find({ [`${table === "products" ? "product" : "property"}_id`]: row.id }).sort({ sort_order: 1 }).toArray()).map(asClient);
    if (["messages", "profiles_public"].includes(table) && row.sender_id) { const p = await mongoose.connection.collection("profiles").findOne({ _id: mongoId(row.sender_id) }); row.profiles = p ? { full_name: p.full_name, avatar_url: p.avatar_url } : null; }
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
    if (action !== "select" && !admin && await mongoose.connection.collection("profiles").findOne({ _id: mongoId(userId), account_status: "suspended" })) return res.status(403).json({ error: "This account is suspended and cannot make changes." });
    if (action !== "select" && req.params.table === "profiles_public") return res.status(403).json({ error: "Public profiles cannot be changed through this route." });
    if (action !== "select" && table === "profiles" && !admin && action !== "update") return res.status(403).json({ error: "Profile records cannot be created or deleted here." });
    if (action !== "select" && !admin && table === "profiles") query._id = mongoId(userId);
    if (action !== "select" && !admin && ownerFields[table] && !["messages", "orders"].includes(table)) query[ownerFields[table]] = userId;
    if (action === "select" && !userId && (privateTables.has(table) || req.params.table === "profiles")) return res.status(401).json({ error: "Sign in to continue." });
    if (action === "select" && userId && !admin && req.params.table === "profiles") query._id = mongoId(userId);
    if (action === "select" && userId && !admin && ["user_roles", "verification_docs", "saved_listings", "saved_searches", "notifications", "reviews", "reports"].includes(table)) {
      if (table === "verification_docs") return res.status(403).json({ error: "Verification documents are only available to platform reviewers." });
      query[ownerFields[table]] = userId;
    }
    if (action === "select" && userId && !admin && ["products", "properties", "services"].includes(table)) {
      const ownerField = ownerFields[table];
      query = { $and: [query, { $or: [{ status: "active", moderation_status: { $ne: "review" } }, { [ownerField]: userId }] }] };
    }
    if (action === "select" && userId && !admin && table === "conversations") query = { $and: [query, { $or: [{ buyer_id: userId }, { other_party_id: userId }] }] };
    if (action === "select" && userId && !admin && table === "orders") query = { $and: [query, { $or: [{ buyer_id: userId }, { seller_id: userId }] }] };
    if (action === "update" && userId && !admin && table === "orders") query = { $and: [query, { $or: [{ buyer_id: userId }, { seller_id: userId }] }] };
    if (action === "select" && userId && !admin && table === "messages") {
      const conversations = await mongoose.connection.collection("conversations").find({ $or: [{ buyer_id: userId }, { other_party_id: userId }] }).project({ _id: 1, id: 1 }).toArray();
      query.conversation_id = { $in: conversations.flatMap((row) => [row.id, row._id?.toString()].filter(Boolean)) };
    }
    if (action === "update" && userId && !admin && table === "messages") {
      const conversations = await mongoose.connection.collection("conversations").find({ $or: [{ buyer_id: userId }, { other_party_id: userId }] }).project({ _id: 1, id: 1 }).toArray();
      query.conversation_id = { $in: conversations.flatMap((row) => [row.id, row._id?.toString()].filter(Boolean)) };
    }
    if (action === "select" && !userId && ["products", "properties", "services"].includes(table)) {
      query = { $and: [query, { status: "active", moderation_status: { $ne: "review" } }] };
    }
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
      let valuesArray = Array.isArray(values) ? values : [values];
      if (table === "reports") {
        const reportKeys = new Set();
        for (const report of valuesArray) {
          if (!reportReasons.has(report?.reason_code) || typeof report.reason !== "string" || report.reason.trim().length < 10 || report.reason.length > 2000) return res.status(400).json({ error: "Choose a report reason and describe the concern in at least 10 characters." });
          const duplicate = await collection.findOne({ reported_by: userId, target_type: report.target_type, target_id: String(report.target_id), status: { $in: ["open", "investigating"] } });
          const reportKey = `${report.target_type}:${String(report.target_id)}`;
          if (duplicate || reportKeys.has(reportKey)) return res.status(409).json({ error: "You have already reported this content. Our team will review it." });
          reportKeys.add(reportKey);
          if (["product", "property", "service"].includes(report.target_type)) {
            const target = await mongoose.connection.collection(listingTables[report.target_type]).findOne({ _id: mongoId(report.target_id) });
            const owner = target?.seller_id || target?.landlord_id || target?.provider_id;
            if (!target || String(owner) === String(userId)) return res.status(400).json({ error: "That listing cannot be reported." });
          } else if (report.target_type === "message") {
            const message = await mongoose.connection.collection("messages").findOne({ _id: mongoId(report.target_id) });
            const conversation = message && await mongoose.connection.collection("conversations").findOne({ $and: [{ $or: [{ id: message.conversation_id }, { _id: mongoId(message.conversation_id) }] }, { $or: [{ buyer_id: userId }, { other_party_id: userId }] }] });
            if (!message || !conversation || message.sender_id === userId) return res.status(400).json({ error: "That message cannot be reported." });
          } else if (report.target_type === "profile") {
            if (!mongoose.isValidObjectId(report.target_id) || String(report.target_id) === String(userId)) return res.status(400).json({ error: "That account cannot be reported." });
          } else return res.status(400).json({ error: "Invalid report target." });
        }
        valuesArray = valuesArray.map((report) => ({ target_type: report.target_type, target_id: String(report.target_id), reason_code: report.reason_code, reason: report.reason.trim(), reported_by: userId, status: "open" }));
      }
      if (table === "saved_searches") {
        const currentCount = await collection.countDocuments({ profile_id: userId });
        if (currentCount + valuesArray.length > 20) return res.status(400).json({ error: "You can save up to 20 searches." });
        const sanitized = [];
        for (const item of valuesArray) {
          if (!["product", "property", "service"].includes(item?.listing_type)) return res.status(400).json({ error: "Choose a valid marketplace category for this alert." });
          const source = item.criteria || {};
          const criteria = {
            query: String(source.query || "").trim().slice(0, 100),
            category: String(source.category || "").trim().slice(0, 80),
            location: String(source.location || "").trim().slice(0, 100),
            min_price: Number(source.min_price) > 0 ? Number(source.min_price) : null,
            max_price: Number(source.max_price) > 0 ? Number(source.max_price) : null,
            transaction_type: ["rent", "sale"].includes(source.transaction_type) ? source.transaction_type : null,
          };
          if (!Object.values(criteria).some(Boolean)) return res.status(400).json({ error: "Add at least one filter before saving this search." });
          const existing = await collection.findOne({ profile_id: userId, listing_type: item.listing_type, criteria });
          if (existing) return res.status(409).json({ error: "You already have an alert for these filters." });
          sanitized.push({ profile_id: userId, listing_type: item.listing_type, criteria, alerts_enabled: true });
        }
        valuesArray = sanitized;
      }
      if (table === "orders") {
        const targets = [];
        const orderKeys = new Set();
        for (const order of valuesArray) {
          const targetTable = listingTables[order?.listing_type];
          const target = targetTable && await mongoose.connection.collection(targetTable).findOne({ _id: mongoId(order.listing_id), status: "active", moderation_status: { $ne: "review" } });
          if (!target) return res.status(404).json({ error: "This listing is unavailable." });
          const owner = target.seller_id || target.landlord_id || target.provider_id;
          if (String(owner) === String(userId)) return res.status(400).json({ error: "You cannot request your own listing." });
          const scheduledAt = ["property", "service"].includes(order.listing_type) ? validSchedule(order.scheduled_at) : null;
          if (["property", "service"].includes(order.listing_type) && !scheduledAt) return res.status(400).json({ error: "Choose a requested date and time within the next 6 months." });
          const orderKey = `${order.listing_type}:${String(order.listing_id)}`;
          if (orderKeys.has(orderKey) || await mongoose.connection.collection("orders").findOne({ buyer_id: userId, listing_type: order.listing_type, listing_id: String(order.listing_id), status: { $in: ["pending", "accepted"] } })) return res.status(409).json({ error: "You already have an open request for this listing." });
          orderKeys.add(orderKey);
          targets.push({ listing_type: order.listing_type, listing_id: String(order.listing_id), buyer_id: userId, seller_id: owner, status: "pending", ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) });
        }
        valuesArray = targets;
      }
      if (table === "conversations") {
        const sanitized = [];
        for (const item of valuesArray) {
          const targetTable = listingTables[item?.listing_type];
          const target = targetTable && await mongoose.connection.collection(targetTable).findOne({ _id: mongoId(item.listing_id), status: "active", moderation_status: { $ne: "review" } });
          const owner = target && (target.seller_id || target.landlord_id || target.provider_id);
          if (!target || String(owner) !== String(item.other_party_id) || String(owner) === String(userId)) return res.status(400).json({ error: "You can only message the owner of an available listing." });
          const existing = await collection.findOne({ listing_type: item.listing_type, listing_id: String(item.listing_id), $or: [{ buyer_id: userId, other_party_id: String(owner) }, { buyer_id: String(owner), other_party_id: userId }] });
          if (existing) return res.status(409).json({ error: "A conversation for this listing already exists.", code: "23505" });
          sanitized.push({ listing_type: item.listing_type, listing_id: String(item.listing_id), buyer_id: userId, other_party_id: String(owner) });
        }
        valuesArray = sanitized;
      }
      if (table === "messages") {
        for (const message of valuesArray) {
          if (typeof message?.content !== "string" || !message.content.trim() || message.content.length > 4000) return res.status(400).json({ error: "Messages must contain up to 4,000 characters." });
          const conversationId = String(message.conversation_id || "");
          const conversation = await mongoose.connection.collection("conversations").findOne({ $and: [{ $or: [{ id: conversationId }, { _id: mongoId(conversationId) }] }, { $or: [{ buyer_id: userId }, { other_party_id: userId }] }] });
          if (!conversation) return res.status(403).json({ error: "You are not a participant in this conversation." });
          if (message.attachment_url) {
            const attachment = await mongoose.connection.collection("uploads").findOne({ path: message.attachment_url, owner_id: String(userId), bucket: "private-chat-attachments" });
            if (!attachment || !String(message.attachment_url).startsWith(`${conversationId}/${userId}/`)) return res.status(400).json({ error: "Invalid message attachment." });
          }
        }
        valuesArray = valuesArray.map((message) => ({ conversation_id: String(message.conversation_id), content: message.content.trim(), attachment_url: message.attachment_url || null, sender_id: userId }));
      }
      if (table === "reviews") {
        const sanitized = [];
        const reviewedOrders = new Set();
        for (const review of valuesArray) {
          const order = await mongoose.connection.collection("orders").findOne({ _id: mongoId(review?.order_id), buyer_id: userId, status: "completed" });
          if (!order || !Number.isInteger(Number(review.rating)) || Number(review.rating) < 1 || Number(review.rating) > 5 || String(review.comment || "").length > 1000) return res.status(400).json({ error: "Reviews require a completed request and a rating from 1 to 5." });
          if (reviewedOrders.has(String(order._id)) || await collection.findOne({ order_id: String(order._id), reviewer_id: userId })) return res.status(409).json({ error: "You have already reviewed this request." });
          reviewedOrders.add(String(order._id));
          sanitized.push({ order_id: String(order._id), reviewer_id: userId, reviewee_id: order.seller_id, rating: Number(review.rating), comment: String(review.comment || "").trim() });
        }
        valuesArray = sanitized;
      }
      if (table === "products" && valuesArray.some((value) => value?.compare_at_price != null && (!Number.isFinite(Number(value.price)) || Number(value.price) <= 0 || !Number.isFinite(Number(value.compare_at_price)) || Number(value.compare_at_price) <= Number(value.price)))) {
        return res.status(400).json({ error: "The original price must be higher than the current price." });
      }
      if (!admin && ["products", "properties", "services"].includes(table)) {
        for (const value of valuesArray) {
          if (typeof value?.title !== "string" || value.title.trim().length < 3 || value.title.length > 140 || typeof value?.description !== "string" || value.description.trim().length < 10 || value.description.length > 5000) return res.status(400).json({ error: "Add a title and a description between 10 and 5,000 characters." });
          if (table !== "services" && (!Number.isFinite(Number(value.price)) || Number(value.price) <= 0)) return res.status(400).json({ error: "Enter a valid price greater than zero." });
        }
        const role = { products: "seller", properties: "landlord", services: "service_provider" }[table];
        const approved = await mongoose.connection.collection("user_roles").findOne({ profile_id: userId, role, status: "approved" });
        if (!approved) return res.status(403).json({ error: `An approved ${role.replace("_", " ")} account is required to publish.` });
      }
      if (table === "products") valuesArray = valuesArray.map((value) => ({ ...value, condition: ["new", "like_new", "good", "fair"].includes(value?.condition) ? value.condition : "good", delivery_option: ["pickup", "delivery", "both"].includes(value?.delivery_option) ? value.delivery_option : "pickup" }));
      if (table === "properties") valuesArray = valuesArray.map((value) => ({ ...value, ...(value.transaction_type === "rent" ? { deposit: Number(value.deposit) >= 0 ? Number(value.deposit) : 0, lease_term: String(value.lease_term || "").slice(0, 100) } : {}) }));
      if (table === "services") valuesArray = valuesArray.map((value) => ({ ...value, availability: String(value.availability || "").trim().slice(0, 250), packages: Array.isArray(value.packages) ? value.packages.map((item) => String(item).trim().slice(0, 180)).filter(Boolean).slice(0, 8) : [] }));
      if (!admin && table === "services") {
        valuesArray = await Promise.all(valuesArray.map(async (value) => {
          const riskFlags = await listingRiskFlags(collection, value, userId, table);
          return { ...value, risk_flags: riskFlags, moderation_status: riskFlags.length ? "review" : "clear" };
        }));
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
        for (const value of valuesArray) {
          const conversationId = String(value?.conversation_id || "");
          const conversation = await mongoose.connection.collection("conversations").findOne({
            $and: [
              { $or: [{ id: conversationId }, { _id: mongoId(conversationId) }] },
              { $or: [{ buyer_id: userId }, { other_party_id: userId }] },
            ],
          });
          if (!conversation) return res.status(403).json({ error: "You are not a participant in this conversation." });
        }
      }
      const docsToInsert = valuesArray.map((value) => ({ ...value, ...(table === "services" && !value.status ? { status: "active" } : {}), ...(ownerFields[table] && !admin ? { [ownerFields[table]]: userId } : {}), ...(table === "user_roles" && !admin ? { role: ["seller", "landlord", "service_provider"].includes(value?.role) ? value.role : "buyer", status: "pending" } : {}), ...(table === "products" || table === "properties" ? { status: "draft" } : {}), created_at: new Date().toISOString() }));
      const inserted = await collection.insertMany(docsToInsert);
      const result = docsToInsert.map((doc, i) => asClient({ ...doc, _id: inserted.insertedIds[i] }));
      if (table === "orders") {
        await mongoose.connection.collection("notifications").insertMany(docsToInsert.map((order) => ({
          profile_id: String(order.seller_id),
          title: order.listing_type === "property" ? "New viewing request" : order.listing_type === "service" ? "New booking request" : "New purchase request",
          body: order.scheduled_at ? `Requested for ${new Date(order.scheduled_at).toLocaleString()}.` : "Open your dashboard to respond.",
          listing_type: order.listing_type,
          listing_id: order.listing_id,
          order_id: String(inserted.insertedIds[docsToInsert.indexOf(order)]),
          created_at: new Date().toISOString(),
          read_at: null,
        })));
      }
      if (table === "services") for (const row of result) await notifySavedSearchMatches("service", { ...row, _id: row.id });
      if (table === "reviews") {
        for (const review of docsToInsert) {
          const [stats] = await collection.aggregate([{ $match: { reviewee_id: review.reviewee_id } }, { $group: { _id: "$reviewee_id", average: { $avg: "$rating" }, count: { $sum: 1 } } }]).toArray();
          if (stats) await mongoose.connection.collection("profiles").updateOne({ _id: mongoId(review.reviewee_id) }, { $set: { rating_avg: Math.round(stats.average * 10) / 10, review_count: stats.count } });
        }
      }
      return res.json({ data: single ? result[0] : result });
    }
    if (action === "update") {
      let updateValues = values || {};
      if (!admin && table === "profiles") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => ["full_name", "phone", "avatar_url"].includes(key)));
      if (!admin && table === "user_roles") updateValues = { status: "pending", application_data: updateValues.application_data };
      if (!admin && table === "verification_docs") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => ["doc_type", "storage_path"].includes(key)));
      if (!admin && table === "messages") updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => key === "read_at"));
      if (!admin && table === "reports") return res.status(403).json({ error: "Reports cannot be edited after submission." });
      if (!admin && table === "reviews") return res.status(403).json({ error: "Posted reviews cannot be edited." });
      if (!admin && ["products", "properties", "services"].includes(table)) {
        const allowed = table === "products" ? ["title", "description", "price", "compare_at_price", "stock", "category", "condition", "delivery_option", "location", "status"] : table === "properties" ? ["title", "description", "price", "location", "bedrooms", "bathrooms", "house_type", "amenities", "deposit", "lease_term", "availability_status", "status"] : ["title", "description", "price_range", "category", "linkedin_url", "service_area", "availability", "packages"];
        updateValues = Object.fromEntries(Object.entries(updateValues).filter(([key]) => allowed.includes(key)));
        if ("status" in updateValues && !["active", "draft"].includes(updateValues.status)) return res.status(400).json({ error: "Invalid listing status." });
      }
      if (table === "products" && ("price" in updateValues || "compare_at_price" in updateValues)) {
        const currentProducts = await collection.find(query).project({ price: 1, compare_at_price: 1 }).toArray();
        const invalidDeal = currentProducts.some((product) => {
          const currentPrice = Object.hasOwn(updateValues, "price") ? updateValues.price : product.price;
          const originalPrice = Object.hasOwn(updateValues, "compare_at_price") ? updateValues.compare_at_price : product.compare_at_price;
          return originalPrice != null && (!Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0 || !Number.isFinite(Number(originalPrice)) || Number(originalPrice) <= Number(currentPrice));
        });
        if (invalidDeal) return res.status(400).json({ error: "The original price must be higher than the current price." });
      }
      if (!admin && ["products", "properties", "services"].includes(table) && updateValues.status === "active") {
        const listings = await collection.find(query).toArray();
        for (const listing of listings) {
          const riskFlags = await listingRiskFlags(collection, { ...listing, ...updateValues }, userId, table);
          await collection.updateOne({ _id: listing._id }, { $set: { ...updateValues, risk_flags: riskFlags, moderation_status: riskFlags.length ? "review" : "clear" } });
          if (!riskFlags.length && listing.status !== "active") await notifySavedSearchMatches(({ products: "product", properties: "property", services: "service" })[table], { ...listing, ...updateValues });
        }
        return res.json({ data: null, count: listings.length });
      }
      let orderRows = [];
      if (table === "orders" && !admin) {
        if (!Object.keys(updateValues).length || Object.keys(updateValues).some((key) => !["status", "scheduled_at"].includes(key)) || ("status" in updateValues && !["accepted", "rejected", "completed", "cancelled"].includes(updateValues.status))) return res.status(400).json({ error: "Only valid request updates are allowed." });
        if ("scheduled_at" in updateValues) {
          const scheduledAt = validSchedule(updateValues.scheduled_at);
          if (!scheduledAt) return res.status(400).json({ error: "Choose a future date and time within the next 6 months." });
          updateValues.scheduled_at = scheduledAt;
        }
        orderRows = await collection.find(query).toArray();
        if (!orderRows.length) return res.status(404).json({ error: "Request not found." });
        for (const order of orderRows) {
          const isBuyer = String(order.buyer_id) === String(userId);
          const isSeller = String(order.seller_id) === String(userId);
          const nextStatus = updateValues.status;
          if ("scheduled_at" in updateValues && !["pending", "accepted"].includes(order.status)) return res.status(403).json({ error: "The requested time can only be changed while a request is open." });
          const buyerMayCancel = isBuyer && ["pending", "accepted"].includes(order.status) && nextStatus === "cancelled";
          const sellerMayRespond = isSeller && order.status === "pending" && ["accepted", "rejected"].includes(nextStatus);
          const sellerMayComplete = isSeller && order.status === "accepted" && nextStatus === "completed";
          const schedulingOnly = !("status" in updateValues) && "scheduled_at" in updateValues && (isBuyer || isSeller);
          if (!(buyerMayCancel || sellerMayRespond || sellerMayComplete || schedulingOnly)) return res.status(403).json({ error: "That request update is not allowed." });
        }
      }
      const result = await collection.updateMany(query, { $set: updateValues });
      if (table === "orders" && !admin && result.modifiedCount) {
        if ("scheduled_at" in updateValues) await collection.updateMany(query, { $unset: { reminder_sent_at: "" } });
        const changedAt = new Date().toISOString();
        const notifications = [];
        for (const order of orderRows) {
          const recipient = String(order.buyer_id) === String(userId) ? order.seller_id : order.buyer_id;
          const title = "status" in updateValues ? `Request ${updateValues.status}` : "Requested time updated";
          notifications.push({ profile_id: String(recipient), title, body: `${order.listing_type} request${updateValues.scheduled_at ? ` · ${new Date(updateValues.scheduled_at).toLocaleString()}` : ""}`, order_id: String(order._id), created_at: changedAt, read_at: null });
        }
        if (notifications.length) await mongoose.connection.collection("notifications").insertMany(notifications);
      }
      return res.json({ data: null, count: result.modifiedCount });
    }
    if (action === "delete") {
      if (!admin && ["orders", "reviews", "reports", "user_roles", "verification_docs"].includes(table)) return res.status(403).json({ error: "This record cannot be deleted through the marketplace." });
      if (!admin && table === "messages") query.sender_id = userId;
      if (!admin && table === "orders") query = { $and: [query, { $or: [{ buyer_id: userId }, { seller_id: userId }] }] };
      const result = await collection.deleteMany(query); return res.json({ data: null, count: result.deletedCount });
    }
    return res.status(400).json({ error: "Invalid operation." });
  } catch (error) { next(error); }
}
