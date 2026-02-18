import { Response } from 'express';

export const logout = async (req: any, res: Response) => {
    req.session.destroy((err: any) => {
        if (err) {
            return res.status(500).json({ message: 'Logout failed' });
        }
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out' });
    });
};
