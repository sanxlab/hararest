import app from './app';
import { config } from './config/default';
import logger from './utils/logger';

const port = config.port;

const server = app.listen(port, () => {
  logger.info(`Server running in ${config.nodeEnv} mode on port ${port}`);
});


process.on('unhandledRejection', (err: Error) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...');
  logger.error(err.name, err.message);
  server.close(() => {
    process.exit(1);
  });
});


process.on('uncaughtException', (err: Error) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  logger.error(err.name, err.message);
  process.exit(1);
});
