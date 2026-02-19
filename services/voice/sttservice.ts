import { STTService } from "./types";
import { createWhisperSTTService } from "./whispersttservice";

// Export it again if other modules depend on it via sttservice.ts
export type { STTService };

/**
 * Factory for STT Service.
 * Now hardcoded to Whisper for local, private, and high-accuracy multi-language support.
 */
export function createSTTService(language: string = 'auto'): STTService {
    console.log(`[STT] Initializing Whisper STT (Automatic Detection: ${language})...`);
    const whisper = createWhisperSTTService();
    whisper.setLanguage(language);
    return whisper;
}
