import mongoose from "mongoose";

const profileSchema = new mongoose.Schema({
  full_name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true, select: false },
  phone: { type: String, default: null },
  avatar_url: { type: String, default: null },
  roles: { type: [String], default: ["buyer"], enum: ["buyer", "seller", "landlord", "service_provider", "admin"] },
  account_status: { type: String, enum: ["active", "suspended"], default: "active" },
}, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } });

export const Profile = mongoose.models.Profile || mongoose.model("Profile", profileSchema);
