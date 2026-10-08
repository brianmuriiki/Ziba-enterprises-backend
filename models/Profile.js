import mongoose from "mongoose";

const profileSchema = new mongoose.Schema({
  full_name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, default: null, select: false },
  google_sub: { type: String, select: false },
  phone: { type: String, default: null },
  avatar_url: { type: String, default: null },
  rating_avg: { type: Number, default: 0 },
  review_count: { type: Number, default: 0 },
  seller_verified: { type: Boolean, default: false },
  landlord_verified: { type: Boolean, default: false },
  service_provider_verified: { type: Boolean, default: false },
  roles: { type: [String], default: ["buyer"], enum: ["buyer", "seller", "landlord", "service_provider", "admin"] },
  account_status: { type: String, enum: ["active", "suspended"], default: "active" },
}, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } });

profileSchema.index({ google_sub: 1 }, { unique: true, sparse: true });

export const Profile = mongoose.models.Profile || mongoose.model("Profile", profileSchema);
