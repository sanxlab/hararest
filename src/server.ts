import app from './app';
import { config } from './config/default';
import logger from './utils/logger';

const port = config.port;

const server = app.listen(port, () => {
  logger.info(`Server running in ${config.nodeEnv} mode on port ${port}`);
});


// Graceful shutdown handler for Docker/Kubernetes container stop signals.
// Stops accepting new connections, waits for in-flight requests to finish,
// then exits cleanly. Force-kills after 10 seconds to prevent hanging.
const gracefulShutdown = (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    logger.info('All connections closed. Exiting.');
    process.exit(0);
  });

  // Force kill after 10 seconds if connections haven't drained
  setTimeout(() => {
    logger.error('Could not close connections in time. Forcefully shutting down.');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));


process.on('unhandledRejection', (err: Error) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...', { error: err.message, stack: err.stack });
  server.close(() => {
    process.exit(1);
  });
});


process.on('uncaughtException', (err: Error) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', { error: err.message, stack: err.stack });
  process.exit(1);
});
