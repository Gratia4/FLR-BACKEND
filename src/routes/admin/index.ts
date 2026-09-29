import { Router } from "express";
import { authenticate, requireStaff } from "../../middleware/authenticate.js";
import registrations from "./registrations.js";
import clients from "./clients.js";
import orders from "./orders.js";
import catalogue from "./catalogue.js";
import inventory from "./inventory.js";
import finance from "./finance.js";
import staff from "./staff.js";
import analytics from "./analytics.js";
import communications from "./communications.js";

const router = Router();

// Every console endpoint requires a staff session; each sub-router then
// applies its own permission gate so a logistics user cannot touch finance.
router.use(authenticate, requireStaff);

router.use(analytics);
router.use("/registrations", registrations);
router.use("/clients", clients);
router.use("/orders", orders);
router.use(catalogue);
router.use(inventory);
router.use(finance);
router.use("/staff", staff);
router.use("/communications", communications);

export default router;
