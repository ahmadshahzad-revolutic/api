import express from 'express';
import cors from 'cors';
import { MONGO_URI } from './config/env';
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


// app.set('trust proxy', 1);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(sessionConfig);


app.get('/', (req, res) => {
    res.send('Hello World!');
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/calls', callRoutes);
app.use('/', chatRoutes);

export default app;
