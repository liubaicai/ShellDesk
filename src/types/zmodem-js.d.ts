declare module 'zmodem.js' {
  export interface Detection {
    confirm: () => ZmodemSession;
    deny: () => void;
    get_session_role?: () => 'send' | 'receive';
    is_valid?: () => boolean;
  }

  export interface OfferDetails {
    name: string;
    size?: number;
    mtime?: Date;
    mode?: number;
    serial?: number;
    files_remaining?: number;
    bytes_remaining?: number;
  }

  export interface Transfer {
    get_details: () => OfferDetails;
    get_offset: () => number;
    send: (chunk: Uint8Array | number[]) => void;
    end: (chunk?: Uint8Array | number[]) => Promise<void>;
  }

  export interface Offer {
    get_details: () => OfferDetails;
    get_offset: () => number;
    on: (event: 'input' | 'complete', callback: (...args: unknown[]) => void) => void;
    accept: (options?: { on_input?: 'spool_uint8array' | 'spool_array' | ((chunk: number[]) => void) }) => Promise<Array<Uint8Array | number[]>>;
    skip: () => void;
  }

  export interface ZmodemSession {
    type: 'send' | 'receive';
    on: (event: 'offer' | 'session_end' | 'garbage', callback: (...args: unknown[]) => void) => void;
    start?: () => void;
    close: () => Promise<void>;
    abort?: () => void;
    send_offer: (details: OfferDetails) => Promise<Transfer | undefined>;
    has_ended?: () => boolean;
  }

  export interface SentryOptions {
    to_terminal: (octets: number[]) => void;
    sender: (octets: number[]) => void;
    on_detect: (detection: Detection) => void;
    on_retract: () => void;
  }

  export class Sentry {
    constructor(options: SentryOptions);
    consume(input: number[] | Uint8Array | ArrayBuffer): void;
    get_confirmed_session?: () => ZmodemSession | null;
  }
}
