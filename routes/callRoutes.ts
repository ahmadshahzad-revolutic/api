import express from 'express';
import { saveCall, getCallHistory } from '../controllers/callController';
import { auth } from '../middleware/auth';

const router = express.Router();

router.post('/log', auth, saveCall);
router.get('/history', auth, getCallHistory);

export default router;
