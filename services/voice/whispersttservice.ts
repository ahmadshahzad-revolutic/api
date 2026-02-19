import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { STTService } from "./types";
import { PYTHON_PATH } from "../../config/env";

export interface WhisperSTTService extends STTService {
    // Add any whisper specific methods here if needed
}

export function createWhisperSTTService(pythonPath: string = PYTHON_PATH): STTService {
    const emitter = new EventEmitter();
    let currentLanguage = "en";
    let isRunning = false;
    let audioBuffer: Buffer = Buffer.alloc(0);
    const CHUNK_SIZE = 16000 * 2; // ~2 seconds of 8kHz 16-bit audio (if we were 16kHz, but we are 8kHz mulaw)
    // Wait, the existing audio is mulaw 8kHz. Whisper needs 16kHz PCM.
    // We'll need to convert mulaw to PCM and maybe resample.

    const WHISPER_DIR = path.join(__dirname, "whisper");
    const TRANSCRIBE_SCRIPT = path.join(WHISPER_DIR, "transcribe.py");
    const TEMP_AUDIO_FILE = path.join(WHISPER_DIR, "temp_chunk.wav");

    const setLanguage = (language: string) => {
        currentLanguage = language;
        console.log(`[WhisperSTT] Language set to: ${language}`);
    };

    const start = async () => {
        console.log("[WhisperSTT] Starting Whisper STT service...");
        isRunning = true;
        emitter.emit("open");
    };

    const processBuffer = async () => {
        if (!isRunning || audioBuffer.length === 0) return;

        const bufferToProcess = audioBuffer;
        audioBuffer = Buffer.alloc(0);

        // For now, we'll save to a temp wav file. 
        // In a more optimized version, we could pipe to stdin of the python script.
        // But for 8GB RAM CPU, simple file-based might be safer for start.

        // CRITICAL: Whisper expects 16kHz PCM. Our input is 8kHz mulaw.
        // We need a way to convert this. ffmpeg is common, but let's see if we can do it in Node or Python.
        // The user guide suggested saving as .wav.

        try {
            // Write raw buffer to file (we'll assume the python script can handle raw or we add a header)
            // Actually, let's use a simple WAV header for the python script.
            fs.writeFileSync(TEMP_AUDIO_FILE, bufferToProcess);

            const py = spawn(pythonPath, [TRANSCRIBE_SCRIPT, TEMP_AUDIO_FILE, currentLanguage]);

            let dataString = "";
            py.stdout.on("data", (data) => {
                dataString += data.toString();
            });

            py.stderr.on("data", (data) => {
                // console.error("[WhisperSTT] Python stderr:", data.toString());
            });

            py.on("close", (code) => {
                try {
                    const result = JSON.parse(dataString);
                    if (result.status === "success" && result.text) {
                        emitter.emit("transcript", result.text);
                        emitter.emit("transcript_metadata", {
                            confidence: 1.0, // Whisper doesn't easily give confidence per segment in this setup
                            is_final: true,
                            text: result.text,
                            language: result.language
                        });
                    }
                } catch (e) {
                    // console.error("[WhisperSTT] Error parsing python output:", dataString);
                }
            });
        } catch (err) {
            console.error("[WhisperSTT] processing error:", err);
        }
    };

    const sendAudio = (chunk: Buffer) => {
        if (!isRunning) return;

        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        // If buffer reaches ~2 seconds, process it
        // 8000 samples/sec * 1 byte/sample (mulaw) * 2 seconds = 16000 bytes
        if (audioBuffer.length >= 16000) {
            processBuffer();
        }
    };

    const stop = () => {
        isRunning = false;
        console.log("[WhisperSTT] Stopped Whisper STT service");
        emitter.emit("close");
    };

    return Object.assign(emitter, {
        setLanguage,
        start,
        sendAudio,
        stop
    }) as STTService;
}
