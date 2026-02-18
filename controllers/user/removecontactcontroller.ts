import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import Contact from '../../models/Contact';

export const removeContact = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        await Contact.findOneAndDelete({ _id: id, owner: req.user?.id });
        res.json({ message: 'Contact removed' });
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
