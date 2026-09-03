export interface ILogger {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}

class ConsoleLogger implements ILogger {
    debug(msg: string, ...args: any[]) { console.debug(`[DEBUG] ${msg}`, ...args); }
    info(msg: string, ...args: any[]) { console.info(`[INFO] ${msg}`, ...args); }
    warn(msg: string, ...args: any[]) { console.warn(`[WARN] ${msg}`, ...args); }
    error(msg: string, ...args: any[]) { console.error(`[ERROR] ${msg}`, ...args); }
}

let currentLogger: ILogger = new ConsoleLogger();

/**
 * Inject a specific logger implementation (e.g., VS Code LogOutputChannel)
 */
export const setLogger = (l: ILogger) => {
    currentLogger = l;
};

/**
 * Universal logger used within the genfoundry project
 */
export const logger: ILogger = {
    debug: (m, ...a) => currentLogger.debug(m, ...a),
    info: (m, ...a) => currentLogger.info(m, ...a),
    warn: (m, ...a) => currentLogger.warn(m, ...a),
    error: (m, ...a) => currentLogger.error(m, ...a),
};
