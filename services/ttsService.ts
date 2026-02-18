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

export class TTSService extends EventEmitter {
    private deepgram: any;
    private elevenLabs: any;
    private provider: 'auto' | 'elevenlabs' | 'deepgram';
    private defaultVoice: string;
    private ttsMutex: Promise<void> = Promise.resolve();
    private currentAbortController: AbortController | null = null;
    private downsampleLeftover: Buffer = Buffer.alloc(0);

    constructor(
        deepgramApiKey: string,
        elevenLabsApiKey?: string,
        voice: string = "aura-asteria-en"
    ) {
        super();
        this.defaultVoice = voice;
        // Default to Deepgram for maximum performance
        this.provider = 'deepgram';

        // Initialize Deepgram
        console.log(`[TTS] Initializing Deepgram Aura TTS...`);
        this.deepgram = createClient(deepgramApiKey);

        // Initialize ElevenLabs if possible
        if (elevenLabsApiKey && !elevenLabsDisabled && process.env.ENABLE_ELEVENLABS === 'true') {
            try {
                const { ElevenLabsClient } = require('elevenlabs');
                this.elevenLabs = new ElevenLabsClient({
                    apiKey: elevenLabsApiKey
                });
                console.log('[TTS] ElevenLabs initialized as primary provider');
            } catch (error: any) {
                console.error('[TTS] ElevenLabs init failed:', error.message);
                this.provider = 'deepgram';
            }
        } else {
            console.log('[TTS] Deepgram fallback mode active (ElevenLabs disabled)');
            this.provider = 'deepgram';
        }
    }

    /**
     * Get appropriate voice model for a language
     */
    getVoiceForLanguage(language: string): string {
        return DEEPGRAM_VOICE_MAP[language] || 'aura-asteria-en';
    }

    /**
     * Synthesize — uses Deepgram directly (or ElevenLabs if available and working)
     * Emits "audio" chunks and "end" event
     */
    async streamTTS(text: string, language: string = 'en') {
        process.stdout.write(`[TTS] Requesting synthesis: "${text.substring(0, 30)}..."\r`);

        // Sequence requests to prevent audio chunk interleaving
        this.ttsMutex = this.ttsMutex.then(async () => {
            // Create a new AbortController for this stream
            this.currentAbortController = new AbortController();
            const signal = this.currentAbortController.signal;

            try {
                // Try ElevenLabs primarily
                if (!elevenLabsDisabled && (this.provider === 'elevenlabs' || this.provider === 'auto') && this.elevenLabs) {
                    try {
                        await this.streamWithElevenLabs(text, language, signal);
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
                const deepgramPromise = this.streamWithDeepgram(text, language, signal);
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
                this.currentAbortController = null;
            }
        });

        return this.ttsMutex;
    }

    /**
     * Stop any ongoing synthesis immediately
     */
    stop() {
        if (this.currentAbortController) {
            console.log('[TTS] Aborting current synthesis');
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
        // We can't easily "clear" a promise chain, but subsequent calls 
        // will check the mutex. We just need to make sure the current one stops emitting audio.
    }

    /**
     * ElevenLabs streaming synthesis
     */
    private async streamWithElevenLabs(text: string, language: string, signal?: AbortSignal) {
        const voiceId = ELEVENLABS_VOICE_MAP['default'];

        console.log(`[TTS-ElevenLabs] Synthesizing: "${text.substring(0, 50)}..."`);

        const audioStream = await this.elevenLabs.textToSpeech.convertAsStream(
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
            this.emit("audio", Buffer.from(chunk));
        }

        this.emit("end");
        console.log(`[TTS-ElevenLabs] Synthesis complete`);
    }

    /**
     * Deepgram streaming synthesis
     */
    private async streamWithDeepgram(text: string, language: string, signal?: AbortSignal) {
        const voiceModel = this.getVoiceForLanguage(language);

        console.log(`[TTS-Deepgram] Synthesizing with voice: ${voiceModel}`);

        try {
            const response = await this.deepgram.speak.request(
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
                this.emit("audio", chunk);
            }

            this.emit("end");

        } catch (error: any) {
            console.error("[TTS-Deepgram] Error:", error);
            this.emit("error", error);
        }
    }

    /**
     * Get current TTS provider
     */
    getProvider(): string {
        return this.provider;
    }

    /**
     * Force switch provider
     */
    setProvider(provider: 'auto' | 'elevenlabs' | 'deepgram') {
        this.provider = provider;
        console.log(`[TTS] Switched to provider: ${provider}`);
    }
}