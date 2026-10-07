import mongoose from "mongoose";

const listingSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ["product", "property", "service"] },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 140 },
  description: { type: String, required: true, maxlength: 5000 },
  price: { type: Number, min: 0 }, price_range: String, category: String, location: String,
  details: { type: mongoose.Schema.Types.Mixed, default: {} }, images: { type: [String], default: [] },
  status: { type: String, enum: ["draft", "active", "taken", "sold", "suspended"], default: "draft", index: true },
}, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } });
listingSchema.index({ type: 1, status: 1, created_at: -1 });
listingSchema.index({ title: "text", description: "text", category: "text" });

export const Listing = mongoose.models.Listing || mongoose.model("Listing", listingSchema);
