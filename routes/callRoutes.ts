import express from 'express';
import { saveCall } from '../controllers/call/savecallcontroller';
import { getCallHistory } from '../controllers/call/getcallhistorycontroller';
import { auth } from '../middleware/auth';

const router = express.Router();

router.post('/log', auth, saveCall);
router.get('/history', auth, getCallHistory);

export default router;
