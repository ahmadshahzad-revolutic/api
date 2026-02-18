import { Router } from 'express';
import { signup } from '../controllers/auth/signupcontroller';
import { login } from '../controllers/auth/logincontroller';
import { profile } from '../controllers/auth/profilecontroller';
import { logout } from '../controllers/auth/logoutcontroller';
import { auth } from '../middleware/auth';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/profile', auth, profile);
router.post('/logout', logout);

export default router;
