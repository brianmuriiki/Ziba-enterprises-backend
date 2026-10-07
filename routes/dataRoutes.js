import { Router } from "express";
import { handleData } from "../controllers/dataController.js";

const router = Router();
router.post("/:table", handleData);
export default router;
