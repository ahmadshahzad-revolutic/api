import express from 'express';
import cors from 'cors';
import { sessionConfig } from './config/session';
import chatRoutes from './routes/chatRoutes';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import callRoutes from './routes/callRoutes';

const app = express();

app.use(cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(sessionConfig);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/calls', callRoutes);
app.use('/', chatRoutes);

export default app;
