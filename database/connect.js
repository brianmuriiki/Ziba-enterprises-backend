import mongoose from "mongoose";

export async function connectDatabase(uri = process.env.MONGODB_URI) {
  if (!uri) throw new Error("MONGODB_URI is required in the backend environment.");
  await mongoose.connect(uri);
  return mongoose.connection;
}

export { mongoose };
