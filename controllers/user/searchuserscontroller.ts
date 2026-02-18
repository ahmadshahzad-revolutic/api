import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import User from '../../models/User';

export const searchUsers = async (req: AuthRequest, res: Response) => {
    try {
        const { query } = req.query;
        if (!query) return res.json([]);

        const users = await User.find({
            $or: [
                { name: { $regex: query as string, $options: 'i' } },
                { number: { $regex: query as string, $options: 'i' } }
            ],
            _id: { $ne: req.user?.id } // Don't search for self
        }).select('name number _id');

        res.json(users);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
