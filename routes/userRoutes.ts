import express from 'express';
import { searchUsers, addContact, getContacts, removeContact, getUsers } from '../controllers/userController';
import { auth } from '../middleware/auth';

const router = express.Router();

router.get('/search', auth, searchUsers);
router.get('/all', auth, getUsers);
router.post('/contacts', auth, addContact);
router.get('/contacts', auth, getContacts);
router.delete('/contacts/:id', auth, removeContact);

export default router;
