import Sqlite = require('better-sqlite3-with-prebuilds');

/**
 * SQLite prefers to have a single connection shared by
 * all users instead of opening and closing multiple connections.
 */
export class DatabaseConnectionCache {
    private connections = new Map<string, Sqlite.Database>();

    openConnection(path: string, options?: Sqlite.Options): Sqlite.Database {
        const existingConnection = this.connections.get(path);
        if (existingConnection) return existingConnection;

        const newConnection = this._createConnection(path, options);
        this.connections.set(path, newConnection);
        return newConnection;
    }

    /**
     * Closes database connection and keeps the data. Should
     * be called at the end of use to allow the process to exit
     * gracefully. No further database operations will be executed.
     */
    closeConnection(path: string): void {
        const connection = this.connections.get(path);
        if (connection) {
            connection.close();
            this.connections.delete(path);
        }
    }

    closeAllConnections(): void {
        this.connections.forEach((conn) => conn.close());
        this.connections.clear();
    }

    /**
     * Closes the database connection and removes all data.
     * With file system databases, it deletes the database file.
     * No further database operations will be executed.
     */
    // dropDatabase() {
    //     this.db.close();
    //     if (this.inMemory) return;
    //     fs.unlinkSync(this.dbFilePath);
    //
    //     // It seems that the extra 2 files are automatically deleted
    //     // when the original file is deleted, but I'm not sure if
    //     // this applies to all OSs.
    //     DATABASE_FILE_SUFFIXES.forEach((suffix) => {
    //         try {
    //             fs.unlinkSync(`${this.dbFilePath}${suffix}`);
    //         } catch (err) {
    //             if (err.code !== 'ENOENT') throw err;
    //         }
    //     });
    // }

    private _createConnection(path: string, options?: Sqlite.Options): Sqlite.Database {
        let connection;
        try {
            connection = new Sqlite(path, options);
        } catch (err) {
            if (/cannot open database because the directory does not exist/i.test(err.message)) {
                err.code = 'ENOENT';
                throw err;
            }
            throw new Error(`Connection to database could not be established at ${path}\nCause: ${err.message}`);
        }
        // WAL mode should greatly improve performance
        // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md
        connection.exec('PRAGMA journal_mode = WAL');
        connection.exec('PRAGMA foreign_keys = ON');
        return connection;
    }
}