declare module 'alsa-capture' {
  import { EventEmitter } from 'events';

  interface AlsaCaptureOptions {
    channels?: number;
    rate?: number;
    format?: string;
    device?: string;
    periodSize?: number;
  }

  class AlsaCapture extends EventEmitter {
    constructor(options?: AlsaCaptureOptions);
    close(): void;
  }

  export default AlsaCapture;
}

declare module 'node-record-lpcm16';
