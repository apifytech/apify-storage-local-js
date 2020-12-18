const fs = require('fs-extra');
const mime = require('mime-types');
const ow = require('ow');
const path = require('path');
const stream = require('stream');
const util = require('util');
const log = require('apify-shared/log');
const { KEY_VALUE_STORE_KEYS } = require('apify-shared/consts');
const { isStream, isBuffer } = require('../utils');
const { maybeParseBody } = require('../body_parser');
const { DEFAULT_API_PARAM_LIMIT } = require('../consts');

const DEFAULT_LOCAL_FILE_EXTENSION = 'bin';
const COMMON_LOCAL_FILE_EXTENSIONS = ['json', 'jpeg', 'png', 'html', 'jpg', 'bin', 'txt', 'xml', 'pdf', 'mp3', 'js', 'css', 'csv'];

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
            this._checkIfKeyValueStoreIsEmpty();
            const stats = await fs.stat(this.storeDir);
            // The platform treats writes as access, but filesystem does not,
            // so if the modification time is more recent, use that.
            const accessedTimestamp = Math.max(stats.atimeMs, stats.mtimeMs);
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

        this._updateTimestamps();
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

        this._updateTimestamps();
        return record;
    }

    /**
     * @param {KeyValueStoreRecord} record
     * @return {Promise<void>}
     */
    async setRecord(record) {
        ow(record, ow.object.exactShape({
            key: ow.string,
            value: ow.any(ow.null, ow.string, ow.number, ow.object),
            contentType: ow.optional.string.nonEmpty,
        }));

        const { key } = record;
        let { value, contentType } = record;

        const isValueStreamOrBuffer = isStream(value) || isBuffer(value);
        // To allow saving Objects to JSON without providing content type
        if (!contentType) {
            if (isValueStreamOrBuffer) contentType = 'application/octet-stream';
            else if (typeof value === 'string') contentType = 'text/plain; charset=utf-8';
            else contentType = 'application/json; charset=utf-8';
        }

        const extension = mime.extension(contentType) || DEFAULT_LOCAL_FILE_EXTENSION;
        const filePath = this._resolvePath(`${key}.${extension}`);

        const isContentTypeJson = extension === 'json';

        if (isContentTypeJson && !isValueStreamOrBuffer && typeof value !== 'string') {
            try {
                value = JSON.stringify(value, null, 2);
            } catch (err) {
                const msg = `The record value cannot be stringified to JSON. Please provide other content type.\nCause: ${err.message}`;
                throw new Error(msg);
            }
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
        this._updateTimestamps({ mtime: true });
    }

    /**
     * @param {string} key
     * @return {Promise<void>}
     */
    async deleteRecord(key) {
        ow(key, ow.string);
        try {
            const result = await this._handleFile(key, fs.unlink);
            if (result) this._updateTimestamps({ mtime: true });
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw err;
            } else {
                throw new Error(`Error deleting file '${key}' in directory '${this.storeDir}'.\nCause: ${err.message}`);
            }
        }
    }

    /**
     * @private
     */
    _checkIfKeyValueStoreIsEmpty() {
        try {
            const files = fs.readdirSync(this.storeDir)
                .filter((file) => !RegExp(KEY_VALUE_STORE_KEYS.INPUT).test(file));
            if (files.length) {
                log.warning(`The following key-value store directory contains a previous state: ${this.storeDir}`
                    + '\n      If you did not intend to persist this key-value store state - '
                    + 'please clear the directory (except INPUT.json file) and re-start the actor.');
            }
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
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

    /**
     * @param {object} [options]
     * @param {boolean} [options.mtime]
     * @private
     */
    _updateTimestamps({ mtime } = {}) {
        // It's throwing EINVAL on Windows. Not sure why,
        // so the function is a best effort only.
        const now = new Date();
        let promise;
        if (mtime) {
            promise = fs.utimes(this.storeDir, now, now);
        } else {
            promise = fs.stat(this.storeDir)
                .then((stats) => fs.utimes(this.storeDir, now, stats.mtime));
        }
        promise.catch(() => { /* we don't care that much if it sometimes fails */ });
    }
}

module.exports = KeyValueStoreClient;
