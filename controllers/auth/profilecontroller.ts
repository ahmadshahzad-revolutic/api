import { Response } from 'express';
import User from '../../models/User';
import { AuthRequest } from '../../middleware/auth';

export const profile = async (req: AuthRequest, res: Response) => {
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
