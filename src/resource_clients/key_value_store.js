const fs = require('fs-extra');
const mime = require('mime-types');
const ow = require('ow');
const path = require('path');
const stream = require('stream');
const util = require('util');
const { maybeParseBody } = require('../body_parser');
const { DEFAULT_API_PARAM_LIMIT } = require('../consts');

const DEFAULT_LOCAL_FILE_EXTENSION = 'bin';
const COMMON_LOCAL_FILE_EXTENSIONS = ['json', 'jpeg', 'png', 'html', 'jpg', 'bin', 'txt', 'xml', 'pdf', 'mp3', 'js', 'css', 'csv'];
const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const streamFinished = util.promisify(stream.finished);

/**
 * @typedef {object} KeyValueStoreRecord
 * @property {string} key
 * @property {*} value
 * @property {string} [contentType]
 */

/**
 * Key-value Store client.
 */
class KeyValueStoreClient {
    /**
     * @param {object} options
     * @param {string} options.id
     * @param {string} options.storageDir
     */
    constructor(options) {
        const {
            name,
            storageDir,
        } = options;

        this.name = name;
        this.storeDir = path.join(storageDir, name);
    }

    async get() {
        try {
            const stats = await fs.stat(this.storeDir);
            // The platform treats writes as access, but filesystem does not,
            // so if the modification time is more recent, use that.
            const accessedTimestamp = Math.max(stats.mtime.getTime(), stats.atime.getTime());
            return {
                id: this.name,
                name: this.name,
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime,
                accessedAt: new Date(accessedTimestamp),
            };
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }

    async update(newFields) {
        // The validation is intentionally loose to prevent issues
        // when swapping to a remote storage in production.
        ow(newFields, ow.object.partialShape({
            name: ow.optional.string.minLength(1),
        }));
        if (!newFields.name) return;

        const newPath = path.join(path.dirname(this.storeDir), newFields.name);
        try {
            await fs.move(this.storeDir, newPath);
        } catch (err) {
            if (/dest already exists/.test(err.message)) {
                throw new Error('Key-value store name is not unique.');
            } else if (err.code === 'ENOENT') {
                this._throw404();
            } else {
                throw err;
            }
        }
        this.name = newFields.name;
    }

    async delete() {
        await fs.remove(this.storeDir);
    }

    async listKeys(options = {}) {
        ow(options, ow.object.exactShape({
            limit: ow.optional.number.greaterThan(0),
            exclusiveStartKey: ow.optional.string,
            desc: ow.optional.boolean,
        }));

        const {
            limit = DEFAULT_API_PARAM_LIMIT,
            exclusiveStartKey,
            desc,
        } = options;

        let files;
        try {
            files = await fs.readdir(this.storeDir);
        } catch (err) {
            if (err.code === 'ENOENT') {
                this._throw404();
            } else {
                throw new Error(`Error listing files in directory '${this.storeDir}'.\nCause: ${err.message}`);
            }
        }

        if (desc) files.reverse();

        const items = [];
        for (const file of files) {
            try {
                const { size } = await fs.stat(this._resolvePath(file));
                items.push({
                    key: path.parse(file).name,
                    size,
                });
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
        }

        // Lexically sort to emulate API.
        items.sort((a, b) => {
            if (a.key < b.key) return -1;
            if (a.key > b.key) return 1;
            return 0;
        });

        let truncatedItems = items;
        if (exclusiveStartKey) {
            const keyPos = items.findIndex((item) => item.key === exclusiveStartKey);
            if (keyPos !== -1) truncatedItems = items.slice(keyPos + 1);
        }

        const limitedItems = truncatedItems.slice(0, limit);

        const lastItemInStore = items[items.length - 1];
        const lastSelectedItem = limitedItems[limitedItems.length - 1];
        const isLastSelectedItemAbsolutelyLast = lastItemInStore === lastSelectedItem;
        const nextExclusiveStartKey = isLastSelectedItemAbsolutelyLast
            ? undefined
            : lastSelectedItem.key;

        return {
            count: items.length,
            limit,
            exclusiveStartKey,
            isTruncated: !nextExclusiveStartKey,
            nextExclusiveStartKey,
            items: limitedItems,
        };
    }

    /**
     * @param {string} key
     * @param {object} [options]
     * @param {boolean} [options.buffer]
     * @param {boolean} [options.stream]
     * @return KeyValueStoreRecord
     */
    async getRecord(key, options = {}) {
        ow(key, ow.string);
        ow(options, ow.object.exactShape({
            buffer: ow.optional.boolean,
            stream: ow.optional.boolean,
            // This option is ignored, but kept here
            // for validation consistency with API client.
            disableRedirect: ow.optional.boolean,
        }));

        const handler = options.stream ? fs.createReadStream : fs.readFile;

        let result;
        try {
            result = await this._handleFile(key, handler);
            if (!result) return;
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw err;
            } else {
                throw new Error(`Error reading file '${key}' in directory '${this.storeDir}'.\nCause: ${err.message}`);
            }
        }

        const record = {
            key,
            value: result.returnValue,
            contentType: mime.contentType(result.fileName),
        };

        const shouldParseBody = !(options.buffer || options.stream);
        if (shouldParseBody) {
            record.value = maybeParseBody(record.value, record.contentType);
        }

        return record;
    }

    /**
     * @param {KeyValueStoreRecord} record
     * @return {Promise<void>}
     */
    async setRecord(record) {
        ow(record, ow.object.exactShape({
            key: ow.string,
            value: ow.any(ow.string, ow.object.plain, ow.number, ow.buffer, ow.object.instanceOf(stream.Readable)),
            contentType: ow.optional.string.nonEmpty,
        }));

        const { key } = record;
        let { value, contentType } = record;

        // To allow saving Objects to JSON without providing content type
        const isValuePlainObject = ow.isValid(value, ow.object.plain);
        if (!contentType) {
            contentType = isValuePlainObject
                ? CONTENT_TYPE_JSON
                : DEFAULT_CONTENT_TYPE;
        }

        const extension = mime.extension(contentType) || DEFAULT_LOCAL_FILE_EXTENSION;
        const filePath = this._resolvePath(`${key}.${extension}`);

        // Could be different charset or separators could
        // be different from CONTENT_TYPE_JSON constant
        const isContentTypeJson = extension === 'json';

        if (isValuePlainObject && isContentTypeJson) {
            value = JSON.stringify(value, null, 2);
        }

        try {
            if (value instanceof stream.Readable) {
                const writeStream = fs.createWriteStream(filePath, value);
                await streamFinished(writeStream);
            } else {
                await fs.writeFile(filePath, value);
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                this._throw404();
            } else {
                throw new Error(`Error writing file '${key}' in directory '${this.storeDir}'.\nCause: ${err.message}`);
            }
        }
    }

    /**
     * @param {string} key
     * @return {Promise<void>}
     */
    async deleteRecord(key) {
        ow(key, ow.string);
        try {
            await this._handleFile(key, fs.unlink);
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw err;
            } else {
                throw new Error(`Error deleting file '${key}' in directory '${this.storeDir}'.\nCause: ${err.message}`);
            }
        }
    }

    /**
     * Helper function to resolve file paths.
     * @param {string} fileName
     * @returns {string}
     * @private
     */
    _resolvePath(fileName) {
        return path.resolve(this.storeDir, fileName);
    }

    /**
     * Helper function to handle files. Accepts a promisified 'fs' function as a second parameter
     * which will be executed against the file saved under the key. Since the file's extension and thus
     * full path is not known, it first performs a check against common extensions. If no file is found,
     * it will read a full list of files in the directory and attempt to find the file again.
     *
     * Returns an object when a file is found and handler executes successfully, undefined otherwise.
     *
     * @param {string} key
     * @param {Function} handler
     * @returns {Promise<?{ returnValue: *, fileName: string }>} undefined or object in the following format:
     * {
     *     returnValue: return value of the handler function,
     *     fileName: name of the file including found extension
     * }
     * @private
     */
    async _handleFile(key, handler) {
        for (const extension of COMMON_LOCAL_FILE_EXTENSIONS) {
            const fileName = `${key}.${extension}`;
            const result = await this._invokeHandler(fileName, handler);
            if (result) return result;
        }

        const fileName = await this._findFileNameByKey(key);
        if (fileName) return this._invokeHandler(fileName, handler);
    }

    async _invokeHandler(fileName, handler) {
        try {
            const filePath = this._resolvePath(fileName);
            const returnValue = await handler(filePath);
            return { returnValue, fileName };
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }

    /**
     * Performs a lookup for a file in the local emulation directory's file list.
     *
     * @param {string} key
     * @returns {Promise<?string>}
     * @private
     */
    async _findFileNameByKey(key) {
        try {
            const files = await fs.readdir(this.storeDir);
            return files.find((file) => key === path.parse(file).name);
        } catch (err) {
            if (err.code === 'ENOENT') this._throw404();
            throw err;
        }
    }

    _throw404() {
        const err = new Error(`Key-value store with id: ${this.name} does not exist.`);
        err.code = 'ENOENT';
        throw err;
    }
}

module.exports = KeyValueStoreClient;
