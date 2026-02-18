import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import { createSTTService, STTService } from "./sttService";
import { createTTSService, TTSService } from "./ttsService";
import { createVADService, VADService } from "./vadService";
import { createTranslationStream, translateText } from "./claudeService";
import { DEEPGRAM_API_KEY, ELEVENLABS_API_KEY } from "../config/env";

interface CallLanguageConfig {
    caller: string;   // Language of the caller (e.g., 'ur', 'hi', 'es', 'auto')
    receiver: string; // Language of the receiver (e.g., 'en')
}

enum CallState {
    LISTENING = 'LISTENING',
    PROCESSING = 'PROCESSING',
    SPEAKING = 'SPEAKING',
    INTERRUPTED = 'INTERRUPTED'
}

export interface AIPeerService {
    pc: RTCPeerConnection;
    isAISpeaking: boolean;
    initializeCall(callerLanguage?: string, receiverLanguage?: string, callerName?: string): void;
    updateCallLanguages(callerLanguage: string, receiverLanguage: string): void;
    createAnswer(offer: any): Promise<any>;
    stop(): Promise<void>;
}

export function createAIPeerService(callId: string = 'default'): AIPeerService {
    console.log("[AI_PEER] Initializing AIPeerService...");
    let pc: RTCPeerConnection;
    let stt: STTService;
    let tts: TTSService;
    let vad: VADService;
    let chatHistory: any[] = [];
    const outputTrack = new MediaStreamTrack({ kind: "audio" });
    let sequenceNumber = 0;
    let timestamp = 0;
    const ssrc = Math.floor(Math.random() * 1000000);
    let audioQueue: Buffer = Buffer.alloc(0);
    let pacerInterval: any = null;

    // Per-call language configuration
    let callLanguages: CallLanguageConfig = { caller: 'en', receiver: 'en' };
    let isTranslationActive = false;
    let sentenceBuffer = ""; // Move to class level for easier clearing
    let lastProcessedTranscript = "";
    let callerName = "User"; // Default name
    let hasSentGreeting = false;
    let claudeAbortController: AbortController | null = null;
    let isAISpeaking = false;
    let controlChannel: any = null;
    let isSilencing = false;
    let lastInterruptionTime = 0;
    let currentResponseText = ""; // Track what the AI is currently saying
    let isInterrupted = false;
    let lastPartialResponse = ""; // Store the text before interruption
    let lastInterruptedQuestion = ""; // Store the question that was being answered

    let state: CallState = CallState.LISTENING;
    let silenceTimer: any = null;
    let transcriptBuffer: string = "";
    const SILENCE_THRESHOLD = 1500; // Reduced from 2.5s to 1.5s for snappier response

    // Distance-Based Filtering Constants (Professional Tier Zones)
    const ZONE_A_DB = -15;       // Zone A: Loud/Close speaker
    const ZONE_A_DUR = 200;      // Zone A: Only 200ms needed
    const ZONE_B_DB = -25;       // Zone B: Normal speaker
    const ZONE_B_DUR = 500;      // Zone B: 500ms needed
    const CONFIDENCE_THRESHOLD = 0.85;
    const NOISE_GATE_DB = -45;   // Ignore anything quieter than this (dB)

    // Latency Constants
    const FAST_SILENCE_THRESHOLD = 500;   // 500ms for final transcripts
    const NORMAL_SILENCE_THRESHOLD = 1500; // 1.5s for interim thoughts

    // Distance-Based Filtering State
    let userSpeechStartTime: number | null = null;
    let currentMaxConfidence = 0;
    let lastAudioLevelDb = -100;
    let peakVolumeThisUtterance = -100;

    // Constructor logic
    pc = new RTCPeerConnection({
        codecs: {
            audio: [
                new RTCRtpCodecParameters({
                    mimeType: "audio/PCMU",
                    clockRate: 8000,
                    channels: 1,
                    payloadType: 0
                }),
            ],
        },
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    console.log("[AI_PEER] RTCPeerConnection created with PCMU support");

    // Initialize STT with caller's language - Use Deepgram Nova-3 (Premium Accuracy)
    console.log("[AI_PEER] Using Deepgram STT (Nova-3)");
    stt = createSTTService(DEEPGRAM_API_KEY, callLanguages.caller);

    // Initialize TTS with Deepgram as default for lower latency
    tts = createTTSService(DEEPGRAM_API_KEY, ELEVENLABS_API_KEY);
    tts.setProvider('deepgram');

    // Initialize Silero VAD
    vad = createVADService();
    vad.init().catch(err => console.error("[AI_PEER] VAD initialization failed:", err));

    console.log("[AI_PEER] Services and Tracks initialized");

    // Create DataChannel for control messages
    controlChannel = pc.createDataChannel("control");

    /**
     * Initialize call with language configuration
     */
    const initializeCall = (clrLang: string = 'en', rcvLang: string = 'en', clrName: string = 'User') => {
        callerName = clrName;
        callLanguages = {
            caller: clrLang,
            receiver: rcvLang
        };

        // Update STT language to match caller
        stt.setLanguage(clrLang);

        // Pre-start STT for lower latency
        stt.start().catch(err => console.error("[AI_PEER] STT pre-start failed:", err));

        console.log(`[AI_PEER] Call ${callId} initialized: ${clrLang} ↔ ${rcvLang}`);
    };

    /**
     * Update languages mid-call
     */
    const updateCallLanguages = (clrLang: string, rcvLang: string) => {
        callLanguages = {
            caller: clrLang,
            receiver: rcvLang
        };
        stt.setLanguage(clrLang);
        console.log(`[AI_PEER] Languages updated: ${clrLang} ↔ ${rcvLang}`);
    };

    const setupHandlers = () => {
        // Add output track to PeerConnection
        pc.addTrack(outputTrack);

        // Handle connection state changes for greeting
        pc.onconnectionstatechange = () => {
            console.log(`[AI_PEER] Connection state: ${pc.connectionState}`);
            if (pc.connectionState === "connected") {
                sendGreeting();
            }
        };

        // Handle incoming tracks
        pc.ontrack = (event) => {
            const track = event.track;
            if (track.kind === "audio") {
                console.log("[AI_PEER] Received audio track");

                track.onReceiveRtp.subscribe(async (rtp) => {
                    // Trigger greeting on first receiving packet
                    if (!hasSentGreeting) {
                        sendGreeting();
                    }
                    stt.sendAudio(rtp.payload);

                    // Volume Calculation (dB)
                    const db = calculateDb(rtp.payload);
                    lastAudioLevelDb = db;

                    // Robust Silero VAD Interruption
                    const isSpeech = await vad.processAudio(rtp.payload);
                    if (isSpeech) {
                        if (!userSpeechStartTime) {
                            userSpeechStartTime = Date.now();
                            peakVolumeThisUtterance = db;
                        }

                        peakVolumeThisUtterance = Math.max(peakVolumeThisUtterance, db);
                        lastAudioLevelDb = db;
                        const duration = Date.now() - userSpeechStartTime;

                        let isInsideZone = false;
                        let targetDuration = ZONE_B_DUR;
                        let zoneLabel = "B";

                        if (db > ZONE_A_DB) {
                            isInsideZone = true;
                            targetDuration = ZONE_A_DUR;
                            zoneLabel = "A (Close)";
                        } else if (db > ZONE_B_DB) {
                            isInsideZone = true;
                            targetDuration = ZONE_B_DUR;
                            zoneLabel = "B (Normal)";
                        }

                        if (isInsideZone && duration > targetDuration) {
                            // Only trigger interruption if AI is actually speaking
                            if (isAISpeaking || isTranslationActive || audioQueue.length > 0) {
                                console.log(`[AI_PEER] Valid Interruption [Zone ${zoneLabel}]: Vol=${db.toFixed(1)}dB, Dur=${duration}ms`);
                                handleInterruption();
                            }
                        }
                    } else {
                        userSpeechStartTime = null;
                    }
                });
            }
        };

        // Handle transcripts
        stt.on("transcript", async (text) => {
            const cleanText = text.trim();
            if (!cleanText) return;

            console.log(`[AI_PEER] STT Final Transcript: "${cleanText}" (Peak Vol: ${peakVolumeThisUtterance.toFixed(1)}dB)`);
            transcriptBuffer = cleanText;
            startSilenceTimer(true);
        });

        // VAD-BASED SPEECH EVENTS
        stt.on("speech_started", () => {
            if (lastAudioLevelDb < NOISE_GATE_DB) return;
            clearSilenceTimer();
        });

        stt.on("speech_ended", async (interimText: string) => {
            if (interimText) {
                transcriptBuffer = interimText.trim();
            }
            startSilenceTimer();
            userSpeechStartTime = null;
        });

        stt.on("transcript_metadata", (data: any) => {
            if (data?.confidence) {
                currentMaxConfidence = Math.max(currentMaxConfidence, data.confidence);

                if ((isAISpeaking || isTranslationActive || audioQueue.length > 0) &&
                    currentMaxConfidence > CONFIDENCE_THRESHOLD &&
                    lastAudioLevelDb > ZONE_B_DB) {

                    console.log(`[AI_PEER] High-Confidence Interruption: Conf=${currentMaxConfidence.toFixed(2)}, Vol=${lastAudioLevelDb.toFixed(1)}dB`);
                    handleInterruption();
                }

                if (!data.is_final && data.text) {
                    startSilenceTimer(false);
                }
            }
        });

        // Handle TTS audio chunks
        tts.on("audio", (chunk: Buffer) => {
            audioQueue = Buffer.concat([audioQueue, chunk]);

            if (!pacerInterval) {
                console.log("[AI_PEER] Starting high-resolution pacer");
                let lastTime = Date.now();

                pacerInterval = setInterval(() => {
                    const now = Date.now();
                    const frameSize = 160; // 20ms at 8kHz u-law
                    const elapsed = now - lastTime;
                    const framesToDispatch = Math.floor(elapsed / 20);
                    const previousSpeaking = isAISpeaking;

                    if (audioQueue.length >= frameSize && !isSilencing) {
                        isAISpeaking = true;
                        if (state !== CallState.INTERRUPTED) {
                            setState(CallState.SPEAKING);
                        }
                    } else {
                        isAISpeaking = false;
                        if (state === CallState.SPEAKING) {
                            setState(CallState.LISTENING);
                        }
                    }

                    if (previousSpeaking !== isAISpeaking && controlChannel && controlChannel.readyState === "open") {
                        controlChannel.send(JSON.stringify({ type: "STATE", isAISpeaking: isAISpeaking }));
                    }

                    for (let i = 0; i < framesToDispatch; i++) {
                        if (audioQueue.length >= frameSize) {
                            const payload = audioQueue.slice(0, frameSize);
                            audioQueue = audioQueue.slice(frameSize);
                            if (isSilencing && audioQueue.length === 0) {
                                isSilencing = false;
                            }

                            const packet = new RtpPacket(
                                new RtpHeader({
                                    payloadType: 0,
                                    sequenceNumber: sequenceNumber++,
                                    timestamp: timestamp,
                                    ssrc: ssrc,
                                }),
                                payload
                            );

                            outputTrack.writeRtp(packet);
                            timestamp += payload.length;
                            lastTime += 20;

                            if (sequenceNumber > 65535) sequenceNumber = 0;
                        } else {
                            isAISpeaking = false;
                            lastTime = now;
                            break;
                        }
                    }
                }, 10);
            }
        });

        stt.on("error", (err) => console.error("[AI_PEER] STT Error:", err));
        tts.on("error", (err) => console.error("[AI_PEER] TTS Error:", err));

        tts.on("end", () => {
            const frameSize = 160;
            const remainder = audioQueue.length % frameSize;
            if (audioQueue.length > 0 && remainder > 0) {
                const padding = Buffer.alloc(frameSize - remainder, 0xFF);
                audioQueue = Buffer.concat([audioQueue, padding]);
            }
        });
    };

    const setupDataChannel = () => {
        if (!controlChannel) return;

        controlChannel.onMessage.subscribe((message: any) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === "INTERRUPT") {
                    handleInterruption();
                }
            } catch (e) { }
        });

        controlChannel.stateChanged.subscribe(() => {
            console.log(`[AI_PEER] Control DataChannel state: ${controlChannel.readyState}`);
        });
    };

    const handleInterruption = () => {
        const now = Date.now();
        if (now - lastInterruptionTime < 500) return;

        if (isAISpeaking || isTranslationActive || audioQueue.length > 0) {
            lastInterruptionTime = now;
            console.log("[AI_PEER] User interrupted AI. Silencing audio...");

            lastPartialResponse = currentResponseText;
            isInterrupted = true;

            if (controlChannel && controlChannel.readyState === "open") {
                controlChannel.send(JSON.stringify({ type: "INTERRUPTED" }));
            }

            tts.stop();
            audioQueue = Buffer.alloc(0);
            isAISpeaking = false;

            if (claudeAbortController) {
                claudeAbortController.abort();
                claudeAbortController = null;
            }

            const silenceFrame = Buffer.alloc(800, 0xFF);
            isSilencing = true;
            audioQueue = silenceFrame;

            sentenceBuffer = "";
            isTranslationActive = false;
            currentResponseText = "";
            setState(CallState.INTERRUPTED);
        }
    };

    const setState = (newState: CallState) => {
        if (state !== newState) {
            console.log(`[AI_PEER] State Transition: ${state} -> ${newState}`);
            state = newState;
            if (controlChannel && controlChannel.readyState === "open") {
                controlChannel.send(JSON.stringify({ type: "STATE_CHANGE", state: newState }));
            }

            if (newState !== CallState.SPEAKING && newState !== CallState.INTERRUPTED) {
                currentMaxConfidence = 0;
            }
        }
    };

    const calculateDb = (buffer: Buffer): number => {
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
            let u = ~buffer[i];
            let sign = (u & 0x80);
            let exponent = (u & 0x70) >> 4;
            let mantissa = (u & 0x0F);
            let sample = (mantissa << 3) + 132;
            sample <<= (exponent);
            sample -= 132;
            const normalized = (sign ? -sample : sample) / 32768.0;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        return 20 * Math.log10(Math.max(rms, 0.00001));
    };

    const startSilenceTimer = (isFinal: boolean = false) => {
        clearSilenceTimer();
        const delay = isFinal ? FAST_SILENCE_THRESHOLD : NORMAL_SILENCE_THRESHOLD;
        silenceTimer = setTimeout(() => {
            finalizeTurn();
        }, delay);
    };

    const clearSilenceTimer = () => {
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
    };

    const finalizeTurn = async () => {
        const text = transcriptBuffer.trim();
        if (!text) {
            setState(CallState.LISTENING);
            return;
        }

        console.log(`[AI_PEER] Silence timeout reached. Processing: "${text}"`);
        lastProcessedTranscript = text;
        transcriptBuffer = "";
        setState(CallState.PROCESSING);
        await handleTranslation(text);
    };

    const handleTranslation = async (text: string) => {
        if (isTranslationActive) return;
        isTranslationActive = true;
        const startTime = Date.now();
        const sourceLang = callLanguages.caller;
        const targetLang = callLanguages.receiver;

        console.log(`[AI_PEER] Translation pipeline: "${text}" (${sourceLang} → ${targetLang})`);

        try {
            if (claudeAbortController) {
                claudeAbortController.abort();
            }
            claudeAbortController = new AbortController();

            const watchdog = setTimeout(() => {
                if (isTranslationActive) {
                    console.error("[AI_PEER] Pipeline Watchdog Triggered: Forcing reset");
                    isTranslationActive = false;
                    claudeAbortController?.abort();
                }
            }, 15000);

            const interruptedContext = isInterrupted ? lastPartialResponse : undefined;
            const interruptedQuestion = isInterrupted ? lastInterruptedQuestion : undefined;

            if (isInterrupted) {
                console.log(`[AI_PEER] Using interrupted context: Ans="${interruptedContext}", Que="${interruptedQuestion}"`);
            }

            // Store current question for potential future interruption
            lastInterruptedQuestion = text;

            const stream = createTranslationStream(
                text,
                targetLang,
                sourceLang,
                chatHistory,
                claudeAbortController.signal,
                interruptedContext,
                interruptedQuestion
            );

            // Reset interruption state
            isInterrupted = false;
            lastPartialResponse = "";

            stream.on("error", (error: any) => {
                const isAbort = error.name === 'AbortError' ||
                    error.name === 'APIUserAbortError' ||
                    error.message?.toLowerCase().includes('aborted');

                if (isAbort) {
                    console.log("[AI_PEER] Claude stream aborted intentionally");
                    return;
                }
                console.error("[AI_PEER] Claude Stream Error:", error);
            });

            let fullTranslation = "";
            sentenceBuffer = "";

            stream.on("text", (delta) => {
                if (!isTranslationActive) return;

                fullTranslation += delta;
                currentResponseText = fullTranslation;
                sentenceBuffer += delta;

                const trimmed = sentenceBuffer.trim();
                const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
                const hasRealContent = /[\u0600-\u06FF\u0900-\u097F\u4e00-\u9fff\w]/.test(trimmed);

                const isSentenceEnd = /[.!?;।؟۔]$/.test(trimmed);
                const isFirstChunk = fullTranslation.length === trimmed.length;
                const minWords = isFirstChunk ? 1 : 3;
                const isClauseEnd = /[,،]/.test(trimmed) && wordCount >= minWords;
                const isTooLong = wordCount >= 6;

                if (hasRealContent && (isSentenceEnd || isClauseEnd || isTooLong)) {
                    console.log(`[AI_PEER] TTS chunk (${Date.now() - startTime}ms): "${trimmed}"`);
                    tts.streamTTS(trimmed, targetLang);
                    sentenceBuffer = "";
                }
            });

            stream.on("finalMessage", () => {
                if (!isTranslationActive) return;

                clearTimeout(watchdog);
                const latency = Date.now() - startTime;
                console.log(`[AI_PEER] Translation complete: "${fullTranslation}" (${latency}ms)`);

                const remaining = sentenceBuffer.trim();
                const hasRealContent = /[\u0600-\u06FF\u0900-\u097F\u4e00-\u9fff\w]/.test(remaining);
                const wordCount = remaining.split(/\s+/).filter(w => w.length > 0).length;

                if (remaining && hasRealContent && (wordCount > 0)) {
                    console.log(`[AI_PEER] Final TTS chunk (${Date.now() - startTime}ms): "${remaining}"`);
                    tts.streamTTS(remaining, targetLang);
                }

                chatHistory.push({ role: "user", content: text });
                chatHistory.push({ role: "assistant", content: fullTranslation });

                if (chatHistory.length > 10) {
                    chatHistory = chatHistory.slice(-10);
                }

                claudeAbortController = null;
                isTranslationActive = false;
                console.log(`[AI_PEER] Pipeline Complete (Total: ${Date.now() - startTime}ms)`);
            });

            await stream.finalMessage();
            clearTimeout(watchdog);

        } catch (error: any) {
            const isAbort = error.name === 'AbortError' ||
                error.name === 'APIUserAbortError' ||
                error.message?.toLowerCase().includes('aborted');

            if (isAbort) {
                console.log("[AI_PEER] Translation pipeline aborted");
                isTranslationActive = false;
                claudeAbortController = null;
                return;
            }

            console.error("[AI_PEER] Translation Error:", error);
            isTranslationActive = false;

            try {
                if (claudeAbortController?.signal.aborted) return;
                const { translation, latency } = await translateText(
                    text,
                    targetLang,
                    sourceLang,
                    chatHistory,
                    claudeAbortController?.signal
                );
                console.log(`[AI_PEER] Fallback translation: "${translation}" (${latency}ms)`);
                tts.streamTTS(translation, targetLang);

                chatHistory.push({ role: "user", content: text });
                chatHistory.push({ role: "assistant", content: translation });
            } catch (fallbackError: any) {
                const isFallbackAbort = fallbackError.name === 'AbortError' ||
                    fallbackError.name === 'APIUserAbortError' ||
                    fallbackError.message?.toLowerCase().includes('aborted');
                if (isFallbackAbort) return;
                console.error("[AI_PEER] Fallback translation failed:", fallbackError);
            }
        }
    };

    const sendGreeting = async () => {
        if (hasSentGreeting) return;
        hasSentGreeting = true;

        const greeting = `Hello ${callerName}! I am your Revolutic Assistant. How can I help you today?`;
        console.log(`[AI_PEER] Sending automated greeting: "${greeting}"`);

        tts.streamTTS(greeting, callLanguages.receiver);
        chatHistory.push({ role: "assistant", content: greeting });
    };

    // Initialize callers
    setupDataChannel();
    setupHandlers();

    return {
        pc,
        get isAISpeaking() { return isAISpeaking; },
        initializeCall,
        updateCallLanguages,
        async createAnswer(offer: any) {
            await pc.setRemoteDescription(offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            return answer;
        },
        async stop() {
            console.log(`[AI_PEER] Stopping call ${callId}`);
            if (pacerInterval) {
                clearInterval(pacerInterval);
                pacerInterval = null;
            }
            chatHistory = [];
            audioQueue = Buffer.alloc(0);
            stt.stop();
            await pc.close();
        }
    };
}
