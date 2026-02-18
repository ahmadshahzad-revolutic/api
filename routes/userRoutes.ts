import express from 'express';
import { searchUsers } from '../controllers/user/searchuserscontroller';
import { getUsers } from '../controllers/user/getuserscontroller';
import { addContact } from '../controllers/user/addcontactcontroller';
import { getContacts } from '../controllers/user/getcontactscontroller';
import { removeContact } from '../controllers/user/removecontactcontroller';
import { auth } from '../middleware/auth';

const router = express.Router();

router.get('/search', auth, searchUsers);
router.get('/all', auth, getUsers);
router.post('/contacts', auth, addContact);
router.get('/contacts', auth, getContacts);
router.delete('/contacts/:id', auth, removeContact);

export default router;
