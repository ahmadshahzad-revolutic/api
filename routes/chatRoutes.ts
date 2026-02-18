import { Router } from 'express';
import { chatHandler } from '../controllers/chat/chatcontroller';

const router = Router();

router.post('/chat', chatHandler);

export default router;
