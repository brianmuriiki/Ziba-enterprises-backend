import { Router } from "express";
import { handleData } from "../controllers/dataController.js";
import { mongoRateLimit } from "../middleware/rateLimit.js";

const router = Router();
router.post("/:table", mongoRateLimit({ windowMs: 60 * 60 * 1000, max: (req) => ({ reports: 8, orders: 30, messages: 120, user_roles: 5, products: 12, properties: 12, services: 12, saved_searches: 20 }[req.params.table] || 80), keyPrefix: "data-write", skip: (req) => req.body?.action === "select" }), handleData);
export default router;
