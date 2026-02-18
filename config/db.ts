import mongoose from 'mongoose';
import { MONGO_URI } from './env';

export const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI as string);
        console.log('MongoDB Connected...');
    } catch (err: any) {
        console.error('Database Connection Error:', err.message);
        process.exit(1);
    }
};
