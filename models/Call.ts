import mongoose from 'mongoose';

const CallSchema = new mongoose.Schema({
    caller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    receiver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false
    },
    status: {
        type: String,
        enum: ['missed', 'completed', 'busy', 'declined'],
        default: 'completed'
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    endTime: {
        type: Date
    },
    duration: {
        type: Number, // in seconds
        default: 0
    },
    direction: {
        type: String,
        enum: ['incoming', 'outgoing'],
        required: true
    }
});

export default mongoose.model('Call', CallSchema);
