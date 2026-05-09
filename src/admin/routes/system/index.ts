import { Router } from "express";
import adminSequencesRouter from "./admin-sequences.js";

const router = Router();

router.use("/admin-sequences", adminSequencesRouter);

export default router;

