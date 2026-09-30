import { EventEmitter } from 'node:events';
export default class AlsaCapture extends EventEmitter { constructor(o) { super(); globalThis.__cap = this; } close() {} }
