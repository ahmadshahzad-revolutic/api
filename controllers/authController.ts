import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User';

export const signup = async (req: Request, res: Response) => {
    try {
        const { name, password } = req.body;
        const email = req.body.email?.trim().toLowerCase();

        if (!email || !password || !name) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        let user = await User.findOne({ email });
        if (user) {
            console.log('[AUTH] Signup failed: User already exists:', email);
            return res.status(400).json({ message: 'User already exists' });
        }

        // Generate a unique 3-digit number for the user (100-999)
        let number = '';
        let isUnique = false;
        while (!isUnique) {
            number = Math.floor(100 + Math.random() * 900).toString();
            const existingUser = await User.findOne({ number });
            if (!existingUser) isUnique = true;
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        user = new User({
            name,
            email,
            password: hashedPassword,
            number
        });

        await user.save();

        console.log('[AUTH] Signup successful for:', email, 'Number:', number);

        (req.session as any).user = {
            id: user.id
        };

        res.json({ user: { id: user.id, name, email, number } });
    } catch (err: any) {
        console.error('[AUTH] Signup Error:', err);
        res.status(500).send('Server error');
    }
};

export const login = async (req: Request, res: Response) => {
    try {
        const email = req.body.email?.trim().toLowerCase();
        const { password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        console.log('[AUTH] Login attempt for:', email);

        const user = await User.findOne({ email });
        if (!user) {
            console.log('[AUTH] Login failed: User not found:', email);
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }


        (req.session as any).user = {
            id: user.id
        };

        res.json({
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                number: user.number
            }
        });
    } catch (err: any) {
        console.error('[AUTH] Login Error:', err);
        res.status(500).send('Server error');
    }
};

export const logout = async (req: Request, res: Response) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ message: 'Logout failed' });
        }
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out' });
    });
};

import { AuthRequest } from '../middleware/auth';

export const getMe = async (req: AuthRequest, res: Response) => {
    try {
        console.log('[AUTH] getMe checking session for user ID:', req.user?.id);
        const user = await User.findById(req.user?.id).select('-password');
        if (!user) {
            console.log('[AUTH] getMe - User not found in database for ID:', req.user?.id);
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
