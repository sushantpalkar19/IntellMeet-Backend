import 'dotenv/config';
import app from './app.js';
import { createServer } from 'http';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { initializeSocketIO } from './socket/index.js';
import { startMeetingReminderScheduler, stopMeetingReminderScheduler } from './services/meetingReminderScheduler.js';

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Connect to MongoDB before starting the server
    await connectDatabase();

    // Create HTTP server
    const httpServer = createServer(app);

    // Initialize Socket.IO
    const io = initializeSocketIO(httpServer);
    startMeetingReminderScheduler();

    const server = httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🔌 Readiness check: http://localhost:${PORT}/api/ready`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔌 WebSocket server initialized`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`${signal} signal received: closing server`);
      stopMeetingReminderScheduler();
      
      // Close Socket.IO
      io.close(() => {
        console.log('Socket.IO server closed');
      });

      server.close(async () => {
        console.log('HTTP server closed');
        try {
          await disconnectDatabase();
          console.log('Graceful shutdown complete');
          process.exit(0);
        } catch (error) {
          console.error('Error during database disconnection:', error);
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
