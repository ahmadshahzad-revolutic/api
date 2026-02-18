import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import Call from '../../models/Call';
import User from '../../models/User';

export const saveCall = async (req: AuthRequest, res: Response) => {
    try {
        const { receiverNumber, otherNumber, direction, status, startTime, endTime, duration } = req.body;
        const currentUserId = req.user?.id;

        const targetNumber = otherNumber || receiverNumber;
        const otherUser = await User.findOne({ number: targetNumber });

        if (!otherUser && targetNumber !== '10') {
            return res.status(404).json({ message: 'Other user not found' });
        }

        let caller, receiver;
        if (direction === 'incoming') {
            caller = otherUser?._id;
            receiver = currentUserId;
        } else {
            caller = currentUserId;
            receiver = otherUser?._id;
        }

        const call = new Call({
            caller,
            receiver,
            status: status || 'completed',
            startTime: startTime || new Date(),
            endTime: endTime || new Date(),
            duration: duration || 0,
            direction: direction || 'outgoing'
        });

        await call.save();
        res.json(call);
    } catch (err: any) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
};
