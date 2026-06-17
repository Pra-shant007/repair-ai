import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest } from '../middleware/auth';
import User from '../models/User';
import { isUsingMockDB, mockDB } from '../config/db';

const JWT_SECRET = process.env.JWT_SECRET || 'repair-ai-copilot-jwt-super-secret-key-1337';

const generateToken = (userId: string, email: string): string => {
  return jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
};

// Sign Up Handler
export const signUp = async (req: AuthenticatedRequest, res: Response) => {
  const { email, password, fullName } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    // Check if user already exists
    let userExists = false;
    if (isUsingMockDB) {
      userExists = mockDB.users.some(u => u.email === email);
    } else {
      const existingUser = await User.findOne({ email });
      userExists = !!existingUser;
    }

    if (userExists) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    let newUser: any;

    if (isUsingMockDB) {
      newUser = {
        _id: `u-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        email,
        passwordHash,
        fullName,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      mockDB.users.push(newUser);
    } else {
      newUser = new User({
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
  } catch (error) {
    return res.status(500).json({ message: 'Registration failed', error: (error as Error).message });
  }
};

// Sign In Handler
export const signIn = async (req: AuthenticatedRequest, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    let user: any = null;

    if (isUsingMockDB) {
      user = mockDB.users.find(u => u.email === email);
    } else {
      user = await User.findOne({ email });
    }

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Verify Password
    const isMatch = await bcrypt.compare(password, user.passwordHash);
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
  } catch (error) {
    return res.status(500).json({ message: 'Login failed', error: (error as Error).message });
  }
};

// Get Profile Handler
export const getProfile = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized access' });
  }

  try {
    let user: any = null;

    if (isUsingMockDB) {
      user = mockDB.users.find(u => u._id === req.user?.id);
    } else {
      user = await User.findById(req.user.id).select('-passwordHash');
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
  } catch (error) {
    return res.status(500).json({ message: 'Retrieving profile failed', error: (error as Error).message });
  }
};

// Social Authentication Mock
export const socialLogin = async (req: AuthenticatedRequest, res: Response) => {
  const { email, fullName, provider } = req.body;

  if (!email || !fullName || !provider) {
    return res.status(400).json({ message: 'Email, fullName and provider details are required' });
  }

  try {
    let user: any = null;

    if (isUsingMockDB) {
      user = mockDB.users.find(u => u.email === email);
      if (!user) {
        user = {
          _id: `u-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          email,
          passwordHash: 'social-oauth-bypass-hash',
          fullName,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        mockDB.users.push(user);
      }
    } else {
      user = await User.findOne({ email });
      if (!user) {
        // Create user with default dummy password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(`social-oauth-${provider}-${Math.random()}`, salt);
        user = new User({ email, fullName, passwordHash });
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
  } catch (error) {
    return res.status(500).json({ message: 'Social authentication failed', error: (error as Error).message });
  }
};
