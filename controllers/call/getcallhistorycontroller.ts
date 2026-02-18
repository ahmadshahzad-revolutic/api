import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import Call from '../../models/Call';

export const getCallHistory = async (req: AuthRequest, res: Response) => {
    try {
        const calls = await Call.find({
            $or: [{ caller: req.user?.id }, { receiver: req.user?.id }]
        })
            .populate('caller', 'name number')
            .populate('receiver', 'name number')
            .sort({ startTime: -1 })
            .limit(50);

        const mappedCalls = calls.map(call => {
            const callObj = call.toObject();
            const currentUserId = req.user?.id;
            const isCaller = callObj.caller?._id?.toString() === currentUserId;
            callObj.direction = isCaller ? 'outgoing' : 'incoming';

            return callObj;
        });

        res.json(mappedCalls);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
