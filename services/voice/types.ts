import { EventEmitter } from "events";

export interface STTService extends EventEmitter {
    setLanguage(language: string): void;
    start(): Promise<void>;
    sendAudio(chunk: Buffer): void;
    stop(): void;
}
