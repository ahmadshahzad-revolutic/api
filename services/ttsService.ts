import { createClient } from "@deepgram/sdk";
import { EventEmitter } from "events";

// Persistent flag — once ElevenLabs fails with 401, disable for entire server lifetime
let elevenLabsDisabled = false;

// Language → Deepgram voice model mapping
const DEEPGRAM_VOICE_MAP: Record<string, string> = {
    'en': 'aura-arcas-en',       // Male, professional (replaced female)
    'en-female': 'aura-asteria-en', // Kept as female option
    'en-male': 'aura-arcas-en',    // Male, professional
    'en-warm': 'aura-luna-en',     // Female, warm
    'en-deep': 'aura-orion-en',    // Male, deep
    'es': 'aura-asteria-en',       // Spanish (use EN voice, Deepgram TTS is EN-focused)
    'hi': 'aura-asteria-en',       // Hindi
    'ur': 'aura-asteria-en',       // Urdu
    'fr': 'aura-asteria-en',       // French
    'de': 'aura-arcas-en',         // German
    'ar': 'aura-asteria-en',       // Arabic
    'zh': 'aura-asteria-en',       // Chinese
    'ja': 'aura-asteria-en',       // Japanese
    'ko': 'aura-asteria-en',       // Korean
    'pt': 'aura-asteria-en',       // Portuguese
    'ru': 'aura-asteria-en',       // Russian
};

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
    setProvider(provider: 'auto' | 'elevenlabs' | 'deepgram'): void;
}

export function createTTSService(
    deepgramApiKey: string,
    elevenLabsApiKey?: string,
    voice: string = "aura-asteria-en"
): TTSService {
    const emitter = new EventEmitter();
    let provider: 'auto' | 'elevenlabs' | 'deepgram' = 'deepgram';
    let ttsMutex: Promise<void> = Promise.resolve();
    let currentAbortController: AbortController | null = null;
    let deepgram: any;
    let elevenLabs: any;

    // Initialize Deepgram
    console.log(`[TTS] Initializing Deepgram Aura TTS...`);
    deepgram = createClient(deepgramApiKey);

    // Initialize ElevenLabs if possible
    if (elevenLabsApiKey && !elevenLabsDisabled && process.env.ENABLE_ELEVENLABS === 'true') {
        try {
            const { ElevenLabsClient } = require('elevenlabs');
            elevenLabs = new ElevenLabsClient({
                apiKey: elevenLabsApiKey
            });
            console.log('[TTS] ElevenLabs initialized as primary provider');
        } catch (error: any) {
            console.error('[TTS] ElevenLabs init failed:', error.message);
            provider = 'deepgram';
        }
    } else {
        console.log('[TTS] Deepgram fallback mode active (ElevenLabs disabled)');
        provider = 'deepgram';
    }

    /**
     * Get appropriate voice model for a language
     */
    const getVoiceForLanguage = (language: string): string => {
        return DEEPGRAM_VOICE_MAP[language] || 'aura-asteria-en';
    };

    /**
     * ElevenLabs streaming synthesis
     */
    const streamWithElevenLabs = async (text: string, language: string, signal?: AbortSignal) => {
        const voiceId = ELEVENLABS_VOICE_MAP['default'];

        console.log(`[TTS-ElevenLabs] Synthesizing: "${text.substring(0, 50)}..."`);

        const audioStream = await elevenLabs.textToSpeech.convertAsStream(
            voiceId,
            {
                text,
                model_id: 'eleven_turbo_v2_5',
                optimize_streaming_latency: 4,
                output_format: 'ulaw_8000', // Native telephony format
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

    /**
     * Deepgram streaming synthesis
     */
    const streamWithDeepgram = async (text: string, language: string, signal?: AbortSignal) => {
        const voiceModel = getVoiceForLanguage(language);

        console.log(`[TTS-Deepgram] Synthesizing with voice: ${voiceModel}`);

        try {
            const response = await deepgram.speak.request(
                { text },
                {
                    model: voiceModel,
                    encoding: "mulaw", // Native telephony format
                    sample_rate: 8000,
                    container: "none"
                }
            );

            const stream = await response.getStream();
            if (!stream) {
                throw new Error("Failed to get audio stream from Deepgram");
            }

            const reader = stream.getReader();

            while (true) {
                if (signal?.aborted) {
                    console.log('[TTS-Deepgram] Stream aborted during iteration');
                    await reader.cancel();
                    break;
                }
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = Buffer.from(value);
                emitter.emit("audio", chunk);
            }

            emitter.emit("end");

        } catch (error: any) {
            console.error("[TTS-Deepgram] Error:", error);
            emitter.emit("error", error);
        }
    };

    /**
     * Synthesize — uses Deepgram directly (or ElevenLabs if available and working)
     * Emits "audio" chunks and "end" event
     */
    const streamTTS = async (text: string, language: string = 'en') => {
        process.stdout.write(`[TTS] Requesting synthesis: "${text.substring(0, 30)}..."\r`);

        // Sequence requests to prevent audio chunk interleaving
        ttsMutex = ttsMutex.then(async () => {
            // Create a new AbortController for this stream
            currentAbortController = new AbortController();
            const signal = currentAbortController.signal;

            try {
                // Try ElevenLabs primarily
                if (!elevenLabsDisabled && (provider === 'elevenlabs' || provider === 'auto') && elevenLabs) {
                    try {
                        await streamWithElevenLabs(text, language, signal);
                        return;
                    } catch (error: any) {
                        if (error.name === 'AbortError') throw error;
                        console.error('[TTS] ElevenLabs failed, falling back to Deepgram:', error.message);
                        if (error.status === 401 || error.status === 429) {
                            elevenLabsDisabled = true;
                        }
                    }
                }

                if (signal.aborted) return;

                // Deepgram (fallback) with stream timeout protection
                const deepgramPromise = streamWithDeepgram(text, language, signal);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Deepgram TTS Stream Timeout')), 10000)
                );

                await Promise.race([deepgramPromise, timeoutPromise]);

            } catch (error: any) {
                if (error.name === 'AbortError') {
                    console.log('[TTS] Stream aborted intentionally');
                } else if (error.message === 'Deepgram TTS Stream Timeout') {
                    console.error('[TTS] Deepgram synthesis timed out, breaking mutex');
                } else {
                    console.error('[TTS] Stream error:', error);
                }
            } finally {
                currentAbortController = null;
            }
        });

        return ttsMutex;
    };

    /**
     * Stop any ongoing synthesis immediately
     */
    const stop = () => {
        if (currentAbortController) {
            console.log('[TTS] Aborting current synthesis');
            currentAbortController.abort();
            currentAbortController = null;
        }
    };

    /**
     * Get current TTS provider
     */
    const getProvider = (): string => {
        return provider;
    };

    /**
     * Force switch provider
     */
    const setProvider = (p: 'auto' | 'elevenlabs' | 'deepgram') => {
        provider = p;
        console.log(`[TTS] Switched to provider: ${p}`);
    };

    return Object.assign(emitter, {
        getVoiceForLanguage,
        streamTTS,
        stop,
        getProvider,
        setProvider
    }) as TTSService;
}
