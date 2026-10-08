import { Router } from "express";
import { chat } from "../controllers/assistantController.js";
import { mongoRateLimit } from "../middleware/rateLimit.js";

const router = Router();
router.post("/chat", mongoRateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyPrefix: "assistant-chat" }), chat);

export default router;
