import { setupLogger, LoggerOptions, LogLevel } from 'the-logger';

const loggerOptions = 
    new LoggerOptions()
        .enableFile(false)
        .pretty(true)
        .subLevel('test', LogLevel.debug);
        
const logger = setupLogger('test', loggerOptions);

export { logger };