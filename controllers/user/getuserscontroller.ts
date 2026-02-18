import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import User from '../../models/User';

export const getUsers = async (req: AuthRequest, res: Response) => {
    try {
        const users = await User.find({ _id: { $ne: req.user?.id } })
            .select('name number _id')
            .sort({ name: 1 });
        res.json(users);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
