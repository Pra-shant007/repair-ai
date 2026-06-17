"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const repairController_1 = require("../controllers/repairController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Secure all repair endpoints
router.use(auth_1.authMiddleware);
router.get('/stats', repairController_1.getDashboardStats);
router.post('/start', repairController_1.startRepair);
router.patch('/:repairId/step', repairController_1.updateRepairStep);
router.post('/report', repairController_1.saveDiagnosticReport);
exports.default = router;
