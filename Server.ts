import http from 'http';
import app from './app';
import { PORT } from './config/env';
import { connectDB } from './config/db';
import { setupSocket } from './services/socket/socketservice';

// ---------------------------
// Start Server with Socket.IO
// ---------------------------
const startServer = async () => {
    // 1. Connect to Database
    await connectDB();

    // 2. Create HTTP Server
    const server = http.createServer(app);

    // 3. Setup Socket.IO
    setupSocket(server);

    // 4. Start Listening
    server.listen(Number(PORT), '0.0.0.0', () => {
        console.log(`Server is running on port ${PORT} and bound to 0.0.0.0`);
    });
};

// Start everything
startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

export default app;
