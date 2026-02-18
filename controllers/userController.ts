import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import User from '../models/User';
import Contact from '../models/Contact';

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
