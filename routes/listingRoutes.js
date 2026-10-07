import { Router } from "express";
import { createListing, deleteListing, listListings, updateListing } from "../controllers/listingController.js";
import { requireAuth } from "../middleware/auth.js";
const router = Router();
router.get("/", listListings);
router.post("/", requireAuth, createListing);
router.patch("/:id", requireAuth, updateListing);
router.delete("/:id", requireAuth, deleteListing);
export default router;
