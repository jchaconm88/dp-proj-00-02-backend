import { Router } from "express";
import adminSequencesRouter from "./admin-sequences.js";
import entitySearchIndexRouter from "./entity-search-index.js";
import countersRouter from "./counters.js";

const router = Router();

router.use("/admin-sequences", adminSequencesRouter);
router.use("/entity-search-index", entitySearchIndexRouter);
router.use("/", countersRouter);

export default router;

