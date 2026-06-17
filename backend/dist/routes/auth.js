"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Public routes
router.post('/signup', authController_1.signUp);
router.post('/signin', authController_1.signIn);
router.post('/social-login', authController_1.socialLogin);
// Protected routes
router.get('/profile', auth_1.authMiddleware, authController_1.getProfile);
exports.default = router;
