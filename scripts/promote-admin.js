import dotenv from "dotenv";
import { connectDatabase, mongoose } from "../database/connect.js";
import { Profile } from "../models/Profile.js";

dotenv.config({ path: new URL("../.env", import.meta.url) });

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error("Usage: npm run admin:promote -- account@example.com");

try {
  await connectDatabase();
  const profile = await Profile.findOneAndUpdate(
    { email },
    { $addToSet: { roles: { $each: ["buyer", "admin"] } } },
    { new: true },
  );
  if (!profile) throw new Error(`No account found for ${email}. Register that address before promoting it.`);
  console.log(`Admin access granted to ${profile.email}.`);
} finally {
  await mongoose.disconnect();
}
