import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import User from '../../models/User';

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
