import { Router } from 'express';
import { chatHandler } from '../controllers/chatController';

const router = Router();

router.post('/chat', chatHandler);

export default router;
