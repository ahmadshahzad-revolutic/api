import { EventEmitter } from "events";

/**
 * TTS Service using ElevenLabs.
 * Hardcoded for high-quality multilingual support.
 */

// ElevenLabs multilingual voice IDs
const ELEVENLABS_VOICE_MAP: Record<string, string> = {
    'default': 'pNInz6obpgDQGcFmaJgB',   // Adam - multilingual
    'female': 'EXAVITQu4vr4xnSDxMaL',     // Bella - multilingual
    'male': 'pNInz6obpgDQGcFmaJgB',       // Adam
};

export interface TTSService extends EventEmitter {
    getVoiceForLanguage(language: string): string;
    streamTTS(text: string, language?: string): Promise<void>;
    stop(): void;
    getProvider(): string;
    setProvider(provider: 'elevenlabs'): void;
}

export function createTTSService(
    elevenLabsApiKey: string,
): TTSService {
    const emitter = new EventEmitter();
    let ttsMutex: Promise<void> = Promise.resolve();
    let currentAbortController: AbortController | null = null;
    let elevenLabs: any;

    if (!elevenLabsApiKey) {
        console.warn('[TTS] ElevenLabs API Key missing. TTS will fail.');
    }

    try {
        const { ElevenLabsClient } = require('elevenlabs');
        elevenLabs = new ElevenLabsClient({
            apiKey: elevenLabsApiKey
        });
        console.log('[TTS] ElevenLabs initialized as primary provider');
    } catch (error: any) {
        console.error('[TTS] ElevenLabs client initialization failed:', error.message);
    }

    const getVoiceForLanguage = (_language: string): string => {
        return ELEVENLABS_VOICE_MAP['default'];
    };

    const streamWithElevenLabs = async (text: string, _language: string, signal?: AbortSignal) => {
        if (!elevenLabs) throw new Error("ElevenLabs client not initialized");

        const voiceId = ELEVENLABS_VOICE_MAP['default'];
        console.log(`[TTS-ElevenLabs] Synthesizing: "${text.substring(0, 50)}..."`);

        const audioStream = await elevenLabs.textToSpeech.convertAsStream(
            voiceId,
            {
                text,
                model_id: 'eleven_turbo_v2_5',
                optimize_streaming_latency: 4,
                output_format: 'ulaw_8000',
            }
        );

        for await (const chunk of audioStream) {
            if (signal?.aborted) {
                console.log('[TTS-ElevenLabs] Stream aborted during iteration');
                break;
            }
            emitter.emit("audio", Buffer.from(chunk));
        }

        emitter.emit("end");
        console.log(`[TTS-ElevenLabs] Synthesis complete`);
    };

    const streamTTS = async (text: string, language: string = 'en') => {
        process.stdout.write(`[TTS] Requesting synthesis: "${text.substring(0, 30)}..."\r`);

        ttsMutex = ttsMutex.then(async () => {
            currentAbortController = new AbortController();
            const signal = currentAbortController.signal;

            try {
                await streamWithElevenLabs(text, language, signal);
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    console.log('[TTS] Stream aborted intentionally');
                } else {
                    console.error('[TTS] Stream error:', error);
                    emitter.emit("error", error);
                }
            } finally {
                currentAbortController = null;
            }
        });

        return ttsMutex;
    };

    const stop = () => {
        if (currentAbortController) {
            console.log('[TTS] Aborting current synthesis');
            currentAbortController.abort();
            currentAbortController = null;
        }
    };

    const getProvider = (): string => "elevenlabs";
    const setProvider = (_p: 'elevenlabs') => { };

    return Object.assign(emitter, {
        getVoiceForLanguage,
        streamTTS,
        stop,
        getProvider,
        setProvider
    }) as TTSService;
}
