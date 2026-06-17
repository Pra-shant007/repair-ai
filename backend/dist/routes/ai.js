"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const aiController_1 = require("../controllers/aiController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Allow optional auth to support guest scan test runs
const optionalAuth = (req, res, next) => {
    if (req.headers.authorization) {
        return (0, auth_1.authMiddleware)(req, res, next);
    }
    next();
};
router.post('/detect', optionalAuth, aiController_1.detectComponents);
router.post('/verify', optionalAuth, aiController_1.verifyStep);
router.post('/chat', optionalAuth, aiController_1.queryAssistant);
exports.default = router;
