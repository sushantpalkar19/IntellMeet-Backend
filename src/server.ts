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

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🔌 Readiness check: http://localhost:${PORT}/api/ready`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔌 WebSocket server initialized`);
    });

    // Graceful shutdown
    let shutdownStarted = false;
    const shutdown = (signal: string) => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      console.log(`${signal} signal received: closing server`);
      stopMeetingReminderScheduler();

      // Socket.IO closes its attached HTTP server as part of close().
      io.close(async () => {
        console.log('Socket.IO and HTTP servers closed');
        try {
          await disconnectDatabase();
          console.log('Graceful shutdown complete');
          process.exit(0);
        } catch (error) {
          console.error('Database shutdown failed:', error instanceof Error ? error.name : 'UnknownError');
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    console.error('Failed to start server:', error instanceof Error ? error.name : 'UnknownError');
    process.exit(1);
  }
}

startServer();
