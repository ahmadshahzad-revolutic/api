import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import Contact from '../../models/Contact';

export const getContacts = async (req: AuthRequest, res: Response) => {
    try {
        const contacts = await Contact.find({ owner: req.user?.id })
            .populate('contact', 'name number')
            .sort({ createdAt: -1 });

        res.json(contacts);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
