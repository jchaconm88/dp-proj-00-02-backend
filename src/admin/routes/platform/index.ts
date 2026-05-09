import { Router } from "express";
import accountsRouter from "./accounts.js";
import companiesRouter from "./companies.js";
import adminAccessRouter from "./admin-access.js";
import companyUsersRouter from "./company-users.js";
import modulesRouter from "./modules.js";
import saasRouter from "./saas.js";
import webRolesRouter from "./web-roles.js";
import webUsersRouter from "./web-users.js";

const router = Router();

router.use("/accounts", accountsRouter);
router.use("/companies", companiesRouter);
router.use("/", adminAccessRouter);
router.use("/", companyUsersRouter);
router.use("/", modulesRouter);
router.use("/", saasRouter);
router.use("/", webRolesRouter);
router.use("/web-users", webUsersRouter);

export default router;
