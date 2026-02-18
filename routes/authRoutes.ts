import { Router } from 'express';
import { login, signup, getMe, logout } from '../controllers/authController';
import { auth } from '../middleware/auth';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', auth, getMe);
router.post('/logout', logout);

export default router;
