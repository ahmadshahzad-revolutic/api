import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import User from '../../models/User';

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
