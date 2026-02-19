import http from 'http';
import app from './app';
import { PORT } from './config/env';
import { connectDB } from './config/db';
import { setupSocket } from './services/socket/socketservice';

const startServer = async () => {
    await connectDB();
    const server = http.createServer(app);
    setupSocket(server);
    server.listen(Number(PORT), '0.0.0.0', () => {
        console.log(`Server is running on port ${PORT} and bound to 0.0.0.0`);
    });
};

startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

export default app;
