import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import Contact from '../../models/Contact';

export const addContact = async (req: AuthRequest, res: Response) => {
    try {
        const { contactId, nickname } = req.body;
        const ownerId = req.user?.id;

        if (contactId === ownerId) {
            return res.status(400).json({ message: 'Cannot add yourself as a contact' });
        }

        let contact = await Contact.findOne({ owner: ownerId, contact: contactId });
        if (contact) {
            return res.status(400).json({ message: 'Contact already exists' });
        }

        contact = new Contact({
            owner: ownerId,
            contact: contactId,
            nickname
        });

        await contact.save();
        res.json(contact);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
