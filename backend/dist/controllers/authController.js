"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.socialLogin = exports.getProfile = exports.signIn = exports.signUp = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const User_1 = __importDefault(require("../models/User"));
const db_1 = require("../config/db");
const JWT_SECRET = process.env.JWT_SECRET || 'repair-ai-copilot-jwt-super-secret-key-1337';
const generateToken = (userId, email) => {
    return jsonwebtoken_1.default.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
};
// Sign Up Handler
const signUp = async (req, res) => {
    const { email, password, fullName } = req.body;
    if (!email || !password || !fullName) {
        return res.status(400).json({ message: 'All fields are required' });
    }
    try {
        // Check if user already exists
        let userExists = false;
        if (db_1.isUsingMockDB) {
            userExists = db_1.mockDB.users.some(u => u.email === email);
        }
        else {
            const existingUser = await User_1.default.findOne({ email });
            userExists = !!existingUser;
        }
        if (userExists) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }
        // Hash the password
        const salt = await bcryptjs_1.default.genSalt(10);
        const passwordHash = await bcryptjs_1.default.hash(password, salt);
        let newUser;
        if (db_1.isUsingMockDB) {
            newUser = {
                _id: `u-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                email,
                passwordHash,
                fullName,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            db_1.mockDB.users.push(newUser);
        }
        else {
            newUser = new User_1.default({
                email,
                passwordHash,
                fullName
            });
            await newUser.save();
        }
        const token = generateToken(newUser._id.toString(), email);
        return res.status(201).json({
            token,
            user: {
                id: newUser._id.toString(),
                email: newUser.email,
                fullName: newUser.fullName
            }
        });
    }
    catch (error) {
        return res.status(500).json({ message: 'Registration failed', error: error.message });
    }
};
exports.signUp = signUp;
// Sign In Handler
const signIn = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }
    try {
        let user = null;
        if (db_1.isUsingMockDB) {
            user = db_1.mockDB.users.find(u => u.email === email);
        }
        else {
            user = await User_1.default.findOne({ email });
        }
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        // Verify Password
        const isMatch = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const token = generateToken(user._id.toString(), user.email);
        return res.status(200).json({
            token,
            user: {
                id: user._id.toString(),
                email: user.email,
                fullName: user.fullName
            }
        });
    }
    catch (error) {
        return res.status(500).json({ message: 'Login failed', error: error.message });
    }
};
exports.signIn = signIn;
// Get Profile Handler
const getProfile = async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Unauthorized access' });
    }
    try {
        let user = null;
        if (db_1.isUsingMockDB) {
            user = db_1.mockDB.users.find(u => u._id === req.user?.id);
        }
        else {
            user = await User_1.default.findById(req.user.id).select('-passwordHash');
        }
        if (!user) {
            return res.status(404).json({ message: 'User profile not found' });
        }
        return res.status(200).json({
            user: {
                id: user._id.toString(),
                email: user.email,
                fullName: user.fullName
            }
        });
    }
    catch (error) {
        return res.status(500).json({ message: 'Retrieving profile failed', error: error.message });
    }
};
exports.getProfile = getProfile;
// Social Authentication Mock
const socialLogin = async (req, res) => {
    const { email, fullName, provider } = req.body;
    if (!email || !fullName || !provider) {
        return res.status(400).json({ message: 'Email, fullName and provider details are required' });
    }
    try {
        let user = null;
        if (db_1.isUsingMockDB) {
            user = db_1.mockDB.users.find(u => u.email === email);
            if (!user) {
                user = {
                    _id: `u-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                    email,
                    passwordHash: 'social-oauth-bypass-hash',
                    fullName,
                    createdAt: new Date(),
                    updatedAt: new Date()
                };
                db_1.mockDB.users.push(user);
            }
        }
        else {
            user = await User_1.default.findOne({ email });
            if (!user) {
                // Create user with default dummy password
                const salt = await bcryptjs_1.default.genSalt(10);
                const passwordHash = await bcryptjs_1.default.hash(`social-oauth-${provider}-${Math.random()}`, salt);
                user = new User_1.default({ email, fullName, passwordHash });
                await user.save();
            }
        }
        const token = generateToken(user._id.toString(), user.email);
        return res.status(200).json({
            token,
            user: {
                id: user._id.toString(),
                email: user.email,
                fullName: user.fullName
            }
        });
    }
    catch (error) {
        return res.status(500).json({ message: 'Social authentication failed', error: error.message });
    }
};
exports.socialLogin = socialLogin;
